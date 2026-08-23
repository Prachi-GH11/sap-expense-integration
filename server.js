const express = require('express');
const hcmService = require('./services/hcmService');
const ficoService = require('./services/ficoService');
const { evaluateExpense } = require('./services/policyEngine');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

// Mock SAP system endpoints — these stand in for real SAP HANA HCM and FICO
// OData services and use the same URL and payload conventions.
app.use('/HCM', hcmService);
app.use('/FICO', ficoService);

/**
 * POST /api/expenses/submit
 * The app's orchestration endpoint. It performs the same sequence a real
 * integration would: resolve employee context from HCM, run the policy
 * engine, resolve GL coding from FICO, and — if compliant or overridden —
 * post the entry to FICO for the next payment run.
 *
 * Body: { employeeId, category, amount, fareClass?, attendeeCount?, override? }
 */
app.post('/api/expenses/submit', async (req, res) => {
  const { employeeId, category, amount, fareClass, attendeeCount, override } = req.body;

  try {
    // 1. Resolve employee context from mock HCM
    const employeeRes = await fetch(
      `${BASE_URL}/HCM/API_EMPLOYEE_SRV/EmployeeSet('${employeeId}')`
    );
    if (!employeeRes.ok) {
      return res.status(404).json({ error: `Employee ${employeeId} not found in HCM` });
    }
    const { d: employee } = await employeeRes.json();

    if (employee.EmploymentStatus !== 'Active') {
      return res.status(403).json({ error: 'Employee is not active; expense submission blocked' });
    }

    // 2. Evaluate policy
    const expense = { category, amount, fareClass, attendeeCount };
    const decision = evaluateExpense(expense, employee);

    if (decision.status === 'blocked' && !override) {
      return res.status(200).json({
        status: 'blocked',
        violations: decision.violations,
        message: 'Expense blocked by policy. Resubmit with override + manager justification to proceed.',
      });
    }

    // 3. Resolve GL coding from mock FICO
    const glRes = await fetch(
      `${BASE_URL}/FICO/API_GLACCOUNTLINEITEM_SRV/GLAccountSet?$filter=ExpenseCategory eq '${category}'`
    );
    const { d: glData } = await glRes.json();
    const glAccount = glData.results[0];
    if (!glAccount) {
      return res.status(422).json({ error: `No GL mapping found for category '${category}'` });
    }

    // 4. Post to mock FICO — queued for next payment run
    const postingRes = await fetch(`${BASE_URL}/FICO/API_GLPOSTING_SRV/PostingSet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ExpenseID: `EXP-${Date.now()}`,
        GLAccount: glAccount.GLAccount,
        CostCenter: employee.CostCenter,
        Amount: amount,
        Currency: 'USD',
      }),
    });
    const { d: posting } = await postingRes.json();

    // 5. Approval routing — resolved from HCM manager hierarchy
    let approver = null;
    if (employee.ManagerID) {
      const managerRes = await fetch(
        `${BASE_URL}/HCM/API_EMPLOYEE_SRV/EmployeeSet('${employee.ManagerID}')`
      );
      if (managerRes.ok) {
        const { d: manager } = await managerRes.json();
        approver = `${manager.FirstName} ${manager.LastName}`;
      }
    }

    res.json({
      status: decision.status === 'flagged' ? 'flagged-pending-approval' : 'compliant-pending-approval',
      violations: decision.violations,
      glPosting: posting,
      routedTo: approver,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Expense app + mock SAP services running on ${BASE_URL}`);
  console.log(`  HCM:  ${BASE_URL}/HCM/API_EMPLOYEE_SRV/EmployeeSet`);
  console.log(`  FICO: ${BASE_URL}/FICO/API_COSTCENTER_SRV/CostCenterSet`);
});

module.exports = app;
