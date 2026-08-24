const express = require('express');
const router = express.Router();
const employees = require('../data/employees.json');
const orgUnits = require('../data/org-structure.json');

// Wraps payloads in SAP OData v2's { d: { results: [...] } } envelope so the
// shape matches what a real HCM OData service returns.
function odataCollection(results) {
  return { d: { results } };
}
function odataEntity(entity) {
  return { d: entity };
}

// GET /HCM/API_EMPLOYEE_SRV/EmployeeSet
// GET /HCM/API_EMPLOYEE_SRV/EmployeeSet?$filter=EmploymentStatus eq 'Active'
router.get('/API_EMPLOYEE_SRV/EmployeeSet', (req, res) => {
  let results = employees;
  const filter = req.query['$filter'];
  if (filter) {
    const match = filter.match(/(\w+)\s+eq\s+'([^']+)'/);
    if (match) {
      const [, field, value] = match;
      results = results.filter((e) => String(e[field]) === value);
    }
  }
  res.json(odataCollection(results));
});

// GET /HCM/API_EMPLOYEE_SRV/EmployeeSet('10045821')
router.get(/\/API_EMPLOYEE_SRV\/EmployeeSet\('(.+)'\)$/, (req, res) => {
  const id = req.params[0];
  const employee = employees.find((e) => e.EmployeeID === id);
  if (!employee) {
    return res.status(404).json({ error: { message: `Employee ${id} not found` } });
  }
  res.json(odataEntity(employee));
});

// GET /HCM/API_ORGSTRUCTURE_SRV/OrgUnitSet
router.get('/API_ORGSTRUCTURE_SRV/OrgUnitSet', (req, res) => {
  res.json(odataCollection(orgUnits));
});

// GET /HCM/API_ORGSTRUCTURE_SRV/OrgUnitSet('10001234')
router.get(/\/API_ORGSTRUCTURE_SRV\/OrgUnitSet\('(.+)'\)$/, (req, res) => {
  const id = req.params[0];
  const orgUnit = orgUnits.find((o) => o.OrgUnit === id);
  if (!orgUnit) {
    return res.status(404).json({ error: { message: `Org unit ${id} not found` } });
  }
  res.json(odataEntity(orgUnit));
});

module.exports = router;
