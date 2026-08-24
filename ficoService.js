const express = require('express');
const router = express.Router();
const costCenters = require('../data/cost-centers.json');
const glAccounts = require('../data/gl-accounts.json');

function odataCollection(results) {
  return { d: { results } };
}
function odataEntity(entity) {
  return { d: entity };
}

// In-memory posting queue standing in for FICO's document + payment run cycle.
const postings = [];
let postingCounter = 5000000001;

// GET /FICO/API_COSTCENTER_SRV/CostCenterSet
router.get('/API_COSTCENTER_SRV/CostCenterSet', (req, res) => {
  res.json(odataCollection(costCenters));
});

// GET /FICO/API_COSTCENTER_SRV/CostCenterSet('CC-4021')
router.get(/\/API_COSTCENTER_SRV\/CostCenterSet\('(.+)'\)$/, (req, res) => {
  const id = req.params[0];
  const cc = costCenters.find((c) => c.CostCenter === id);
  if (!cc) return res.status(404).json({ error: { message: `Cost center ${id} not found` } });
  res.json(odataEntity(cc));
});

// GET /FICO/API_GLACCOUNTLINEITEM_SRV/GLAccountSet
// GET /FICO/API_GLACCOUNTLINEITEM_SRV/GLAccountSet?$filter=ExpenseCategory eq 'Hotel'
router.get('/API_GLACCOUNTLINEITEM_SRV/GLAccountSet', (req, res) => {
  let results = glAccounts;
  const filter = req.query['$filter'];
  if (filter) {
    const match = filter.match(/(\w+)\s+eq\s+'([^']+)'/);
    if (match) {
      const [, field, value] = match;
      results = results.filter((g) => g[field] === value);
    }
  }
  res.json(odataCollection(results));
});

// POST /FICO/API_GLPOSTING_SRV/PostingSet
// Simulates posting an approved expense as a GL document queued for the next payment run.
router.post('/API_GLPOSTING_SRV/PostingSet', (req, res) => {
  const { GLAccount, CostCenter, Amount, Currency, ExpenseID, PostedBy, CreatedBy, OnBehalfOf } = req.body;
  if (!GLAccount || !CostCenter || !Amount) {
    return res.status(400).json({ error: { message: 'GLAccount, CostCenter, and Amount are required' } });
  }
  if (!PostedBy) {
    return res.status(400).json({
      error: { message: 'PostedBy is required — the offsetting entry must reference a real User ID, not a clearing account.' },
    });
  }
  const posting = {
    PostingID: String(postingCounter++),
    ExpenseID,
    GLAccount,
    CostCenter,
    Amount,
    Currency: Currency || 'USD',
    Status: 'Queued for payment run',
    PostingDate: new Date().toISOString().slice(0, 10),
    // Audit trail fields — fixes the "G/L shows clearing account instead of
    // User ID" and "Posted By not visible" gaps by making both mandatory
    // on every posting rather than optional metadata.
    PostedBy,
    CreatedBy: CreatedBy || PostedBy,
    OnBehalfOf: OnBehalfOf || null,
  };
  postings.push(posting);
  res.status(201).json(odataEntity(posting));
});

// GET /FICO/API_GLPOSTING_SRV/PostingSet — lets the demo show what's queued
router.get('/API_GLPOSTING_SRV/PostingSet', (req, res) => {
  res.json(odataCollection(postings));
});

module.exports = router;
