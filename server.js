const express = require('express');
const hcmService = require('./services/hcmService');
const ficoService = require('./services/ficoService');
const { evaluateExpense, calculatePerDiem, recalculatePerDiem } = require('./services/policyEngine');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

// Mock SAP system endpoints — these stand in for real SAP HANA HCM and FICO
// OData services and use the same URL and payload conventions.
app.use('/HCM', hcmService);
app.use('/FICO', ficoService);

// In-memory store standing in for a real expense document table. Holds
// items from submission through approval/rejection. This is what makes
// reject-with-reason and the approver dashboard possible — previously the
// app posted straight to FICO on submit, which skipped human approval
// entirely.
const expenses = {};
let expenseCounter = 1;

/**
 * POST /api/expenses/submit
 * Resolves employee context from HCM, runs the policy engine, and resolves
 * GL coding preview from FICO. Does NOT post to FICO — posting only happens
 * on explicit approval (see /approve below). Blocked items require an
 * override + justification to even enter the pending queue.
 *
 * Body: { employeeId, category, amount, fareClass?, attendeeCount?, override?,
 *         justification?, onBehalfOfEmployeeId? }
 */
app.post('/api/expenses/submit', async (req, res) => {
  const {
    employeeId, category, amount, fareClass, attendeeCount,
    override, justification, onBehalfOfEmployeeId,
  } = req.body;

  try {
    // 1. Resolve employee (and, for on-behalf submissions, the traveler) from HCM
    const employeeRes = await fetch(`${BASE_URL}/HCM/API_EMPLOYEE_SRV/EmployeeSet('${employeeId}')`);
    if (!employeeRes.ok) {
      return res.status(404).json({ error: `Employee ${employeeId} not found in HCM` });
    }
    const { d: submitter } = await employeeRes.json();

    if (submitter.EmploymentStatus !== 'Active') {
      return res.status(403).json({ error: 'Employee is not active; expense submission blocked' });
    }

    let traveler = submitter;
    if (onBehalfOfEmployeeId && onBehalfOfEmployeeId !== employeeId) {
      const travelerRes = await fetch(`${BASE_URL}/HCM/API_EMPLOYEE_SRV/EmployeeSet('${onBehalfOfEmployeeId}')`);
      if (!travelerRes.ok) {
        return res.status(404).json({ error: `Traveler ${onBehalfOfEmployeeId} not found in HCM` });
      }
      traveler = (await travelerRes.json()).d;
    }

    // 2. Evaluate policy against the traveler's grade/context, not the submitter's
    const expense = { category, amount, fareClass, attendeeCount };
    const decision = evaluateExpense(expense, traveler);

    if (decision.status === 'blocked' && !override) {
      return res.status(200).json({
        status: 'blocked',
        violations: decision.violations,
        message: 'Expense blocked by policy. Resubmit with override + justification to proceed.',
      });
    }
    if (decision.status === 'blocked' && override && !justification) {
      return res.status(400).json({ error: 'Override requires a justification note.' });
    }

    // 3. Resolve GL coding preview from mock FICO (not posted yet)
    const glRes = await fetch(
      `${BASE_URL}/FICO/API_GLACCOUNTLINEITEM_SRV/GLAccountSet?$filter=ExpenseCategory eq '${category}'`
    );
    const { d: glData } = await glRes.json();
    const glAccount = glData.results[0];
    if (!glAccount) {
      return res.status(422).json({ error: `No GL mapping found for category '${category}'` });
    }

    // 4. Approval routing — resolved from the traveler's HCM manager hierarchy
    let approver = null;
    if (traveler.ManagerID) {
      const managerRes = await fetch(`${BASE_URL}/HCM/API_EMPLOYEE_SRV/EmployeeSet('${traveler.ManagerID}')`);
      if (managerRes.ok) {
        approver = (await managerRes.json()).d;
      }
    }

    // 5. Store as pending — nothing posts to FICO until an approver acts
    const expenseId = `EXP-${expenseCounter++}`;
    expenses[expenseId] = {
      expenseId,
      submitter,
      traveler,
      onBehalf: onBehalfOfEmployeeId ? true : false,
      category, amount, fareClass, attendeeCount,
      decision, justification: justification || null,
      glAccount,
      approver,
      state: decision.status === 'blocked' ? 'pending-override-approval' : 'pending-approval',
      reasonCode: null,
      reasonNote: null,
      posting: null,
    };

    res.status(201).json({
      expenseId,
      status: decision.status === 'flagged' ? 'flagged-pending-approval'
        : decision.status === 'blocked' ? 'override-pending-approval'
        : 'compliant-pending-approval',
      violations: decision.violations,
      glAccountPreview: glAccount,
      routedTo: approver ? `${approver.FirstName} ${approver.LastName}` : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/expenses/pending — feeds the approver dashboard
app.get('/api/expenses/pending', (req, res) => {
  const pending = Object.values(expenses).filter((e) => e.state.startsWith('pending'));
  res.json(pending);
});

// GET /api/expenses/:id — full record, including reason if rejected
app.get('/api/expenses/:id', (req, res) => {
  const expense = expenses[req.params.id];
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  res.json(expense);
});

/**
 * POST /api/expenses/:id/approve
 * The only place a GL posting is created. Stamps PostedBy/CreatedBy/OnBehalfOf
 * on the posting — fixes the "G/L shows clearing account instead of User ID"
 * and "Created By missing on on-behalf PDF" gaps by making identity mandatory
 * at the point of posting rather than optional metadata added later.
 */
app.post('/api/expenses/:id/approve', async (req, res) => {
  const expense = expenses[req.params.id];
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  if (!expense.state.startsWith('pending')) {
    return res.status(409).json({ error: `Expense is already ${expense.state}` });
  }

  const postingRes = await fetch(`${BASE_URL}/FICO/API_GLPOSTING_SRV/PostingSet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ExpenseID: expense.expenseId,
      GLAccount: expense.glAccount.GLAccount,
      CostCenter: expense.traveler.CostCenter,
      Amount: expense.amount,
      Currency: 'USD',
      PostedBy: expense.traveler.EmployeeID,
      CreatedBy: expense.submitter.EmployeeID,
      OnBehalfOf: expense.onBehalf ? expense.traveler.EmployeeID : null,
    }),
  });
  const { d: posting } = await postingRes.json();

  expense.state = 'approved';
  expense.posting = posting;
  res.json({ status: 'approved', posting });
});

/**
 * POST /api/expenses/:id/reject
 * Body: { reasonCode, reasonNote }
 * Fixes the "no rejection reason captured or shown" gap — the reason is
 * stored once and is visible via GET /api/expenses/:id to the requester,
 * to Finance, and to any approver checking the record, rather than being
 * emailed once and lost.
 */
app.post('/api/expenses/:id/reject', (req, res) => {
  const expense = expenses[req.params.id];
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  const { reasonCode, reasonNote } = req.body;
  if (!reasonCode) {
    return res.status(400).json({ error: 'reasonCode is required to reject an expense' });
  }
  expense.state = 'rejected';
  expense.reasonCode = reasonCode;
  expense.reasonNote = reasonNote || null;
  res.json({ status: 'rejected', reasonCode, reasonNote });
});

/**
 * POST /api/per-diem/calculate
 * Body: { country, startDate, endDate, mealsIncluded?, previousTotal? }
 * Standalone endpoint so the "recalculate on date change" behavior can be
 * demoed without a full travel-request entity model. A UI would call this
 * every time trip dates change and diff against previousTotal.
 */
app.post('/api/per-diem/calculate', (req, res) => {
  const { country, startDate, endDate, mealsIncluded, previousTotal } = req.body;
  const result = previousTotal !== undefined
    ? recalculatePerDiem(previousTotal, { country, startDate, endDate, mealsIncluded })
    : calculatePerDiem({ country, startDate, endDate, mealsIncluded });
  if (result.error) return res.status(422).json(result);
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Expense app + mock SAP services running on ${BASE_URL}`);
  console.log(`  HCM:  ${BASE_URL}/HCM/API_EMPLOYEE_SRV/EmployeeSet`);
  console.log(`  FICO: ${BASE_URL}/FICO/API_COSTCENTER_SRV/CostCenterSet`);
});

module.exports = app;
