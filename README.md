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

Server runs on `http://localhost:3000`. Open that URL in a browser for the
demo frontend — pick an employee, submit an expense, watch it get
blocked/flagged/cleared, and see it land in the FICO payment queue below the
form. Everything on that page hits the real backend, not mock UI state.

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
- `POST /FICO/API_GLPOSTING_SRV/PostingSet` — requires `PostedBy`; rejects
  postings without an identity, by design (see traceability table below)
- `GET /FICO/API_GLPOSTING_SRV/PostingSet` (view the queue)

**App orchestration**
- `POST /api/expenses/submit` — resolves employee from HCM, runs the policy
  engine, resolves a GL coding **preview** from FICO, and routes to the
  approver from the HCM manager hierarchy. Does **not** post to FICO —
  nothing posts until an approver acts.
- `GET /api/expenses/pending` — feeds the approver dashboard
- `GET /api/expenses/:id` — full record, including rejection reason if rejected
- `POST /api/expenses/:id/approve` — the only place a GL posting is created;
  stamps `PostedBy`/`CreatedBy`/`OnBehalfOf`
- `POST /api/expenses/:id/reject` — body `{ reasonCode, reasonNote }`
- `POST /api/per-diem/calculate` — body `{ country, startDate, endDate, mealsIncluded?, previousTotal? }`;
  omit `previousTotal` for an initial calculation, include it to get a
  recalculation with a `changed` flag

## Traceability to the customer gap analysis

This repo's data model and orchestration logic were extended directly from
a customer workshop gap list (AS-IS/To-Be). Each row below is a real gap;
see `travel-mgmt-gap-analysis.md` in the case study for the full writeup.

| Gap | Where it's fixed in this repo |
|---|---|
| G/L shows clearing account instead of User ID | `ficoService.js` — `PostedBy` is a required field on every posting |
| 'Posted By' not visible on postings | `PostingSet` response includes `PostedBy` on every record |
| 'Created By' missing on on-behalf submissions | `server.js` — `onBehalfOfEmployeeId` param; posting carries both `CreatedBy` and `OnBehalfOf` |
| No rejection reason captured or shown | `POST /api/expenses/:id/reject` + `reasonCode`/`reasonNote` on the record, visible via `GET /api/expenses/:id` |
| Per diem not recalculated on date change | `policyEngine.js` — `recalculatePerDiem()`, exposed via `/api/per-diem/calculate` |
| No approval gate before posting | `server.js` — submissions are held as `pending-approval`; `/approve` is the only path to a GL posting |

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
