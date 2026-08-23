# SAP Expense Integration Prototype

A working prototype of the point-of-entry policy compliance and auto-coding
engine described in the case study. Includes mock SAP HCM and FICO OData
services and an orchestration layer that calls them over real HTTP requests
(not just in-process function calls), so the integration pattern is honest.

## Run it

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`.

## What's mocked vs. real

This prototype mocks the SAP layer rather than connecting to a live tenant
(gated/expensive to access). The mocks intentionally mirror real SAP
conventions so the integration pattern is credible:

- Endpoint naming follows actual SAP API service names
  (`API_EMPLOYEE_SRV`, `API_ORGSTRUCTURE_SRV`, `API_COSTCENTER_SRV`,
  `API_GLACCOUNTLINEITEM_SRV`).
- Responses use SAP OData v2's `{ "d": { "results": [...] } }` envelope for
  collections and `{ "d": {...} }` for single entities.
- `$filter` query syntax is supported (simplified `field eq 'value'` parsing).
- The FICO posting endpoint simulates a GL document being queued for the
  next payment run, rather than an instant payment — matching how FICO
  actually batches disbursements.

## Endpoints

**Mock HCM**
- `GET /HCM/API_EMPLOYEE_SRV/EmployeeSet`
- `GET /HCM/API_EMPLOYEE_SRV/EmployeeSet('<id>')`
- `GET /HCM/API_ORGSTRUCTURE_SRV/OrgUnitSet`

**Mock FICO**
- `GET /FICO/API_COSTCENTER_SRV/CostCenterSet`
- `GET /FICO/API_GLACCOUNTLINEITEM_SRV/GLAccountSet?$filter=ExpenseCategory eq 'Hotel'`
- `POST /FICO/API_GLPOSTING_SRV/PostingSet`
- `GET /FICO/API_GLPOSTING_SRV/PostingSet` (view the queue)

**App orchestration**
- `POST /api/expenses/submit` — resolves employee from HCM, runs the policy
  engine, resolves GL coding from FICO, posts if compliant, and routes to
  the approver from the HCM manager hierarchy.

## Try it

Blocked (M3 employee, business class — policy requires M5+):

```bash
curl -X POST http://localhost:3000/api/expenses/submit \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"10045821","category":"Airfare - international","amount":1450,"fareClass":"business"}'
```

Compliant (same employee, economy):

```bash
curl -X POST http://localhost:3000/api/expenses/submit \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"10045821","category":"Airfare - international","amount":650,"fareClass":"economy"}'
```

See what's queued for the next FICO payment run:

```bash
curl http://localhost:3000/FICO/API_GLPOSTING_SRV/PostingSet
```

## Known simplifications (call these out honestly in the case study)

- Postings are held in memory and reset on restart — no real payment run.
- `$filter` parsing only handles a single `field eq 'value'` clause.
- No auth/OAuth layer — real SAP OData services require client credentials
  or principal propagation via SAP Cloud Connector.
- Per-diem/multi-currency FX timing is out of scope for this prototype
  (see `data/policy-rules.json` in the main case study for the data model).

## Sample employees for testing

| EmployeeID | Name | Grade | Manager |
|---|---|---|---|
| 10045821 | Priya Nair | M3 | 10032190 |
| 10032190 | Arjun Mehta | M6 | 10011000 |
| 10011000 | Sana Iyer | M8 | — |
