# Travel Management Gap Analysis — To-Be Solution Mapping

Source: onsite customer workshops on the current HCM Travel Management (Fiori) implementation.
This maps each AS-IS gap to where it's resolved in the expense & travel tool, and flags which
gaps are app-layer fixes vs. SAP configuration/feasibility questions.

---

## 1. Financial posting integrity — G/L and audit trail visibility

**Gaps covered:** G/L 5005000 showing instead of correct User ID · 'Posted By' not visible on
G/L 1200226 · 'Created By' missing from on-behalf expense PDFs · Posting Keys/'Created By' not
visible in PRRW pre-posting.

**Root cause:** These are almost always FI document field mapping issues — the offsetting entry
is picking up a generic clearing account instead of the employee/vendor reference, and the
`Created By` / `Posted By` fields exist in the FI document header (`BKPF-USNAM`) but aren't
surfaced in the layouts users see (PRRW line item display, the expense PDF form, Fiori app
field catalog).

**Where this lives in our tool:** The **auto-coder module** is the natural owner. Right now it
resolves `expenseCategory → GLAccount`. Extend it to also stamp two identity fields onto every
GL posting payload before it's sent to FICO:

```json
{
  "GLAccount": "1200226",
  "CostCenter": "CC-4021",
  "Amount": 1450,
  "PostedBy": "10045821",
  "CreatedBy": "10045821",
  "OnBehalfOf": null
}
```

For on-behalf submissions, `CreatedBy` is the delegate's employee ID and a separate
`SubmittedFor` field carries the actual traveler — this is the field our current `PostingSet`
mock doesn't yet carry, and it's the fix for the "on-behalf PDF" gap specifically. The PDF
generation layer (not yet built in the prototype) should pull `CreatedBy` from this same payload
rather than defaulting to the traveler's name.

**PRRW visibility** (Posting Keys + Created By before FI transfer) is a **Fiori layout/config
fix on the SAP side**, not something our app layer touches — it's about exposing existing BKPF
fields in the PRRW list view before the transfer step runs. Worth stating this distinction
explicitly in the case study: not every "To-Be" line item is new code — some are configuration
gaps in the existing SAP implementation.

---

## 2. Document lifecycle control — attachment deletion

**Gap:** Attachments can be deleted after Final Approval, with no protection.

**Root cause:** No status-based lock on the attachment object; deletion permission isn't
conditioned on the document's workflow state.

**Where this lives:** A new **document lifecycle guard**, sitting alongside the approval router
in the app architecture. Simple state machine:

| Document status | Attachment deletion allowed? |
|---|---|
| Draft | Yes |
| Pending approval | Yes |
| Final approved | **No** |
| Rejected | Yes |
| Cancelled | Yes |

This is a straightforward addition to the `submission.state` model already in the prototype —
the delete action just needs a guard clause checking `state !== 'approved'` before it runs.

---

## 3. Access & authorization — delegate errors

**Gap:** Delegates with correctly assigned roles still get "not authorised" errors.

**Root cause:** This pattern (correct role, still blocked) is almost always an **authorization
object field value mismatch** — e.g., the role has the right transaction/activity, but a field
like cost center range, org unit, or company code in the authorization object doesn't include
the delegate's actual assignment. It's rarely the role itself; it's usually a scoping value
inside it.

**Where this lives:** This isn't an app-layer fix in our tool — it's a **security/Basis
remediation** on the SAP side (auth trace via `ST01`/`SU53` to find the specific object and
value failing). Worth noting in the case study as a gap that's outside the tool's own design
surface but still belongs on the To-Be roadmap, since it blocks adoption regardless of how good
the app UX is.

---

## 4. Workflow communication — notifications and rejection reasons

**Gaps covered:** No email notifications at any stage · no rejection reason captured or shown to
Finance, approvers, or the requester.

**Where this lives:** Both are **approval router** extensions, and both are things our
prototype's data model can support today with two additions:

**a) Notification service** (new component, hangs off every state transition):

```
submission → pending        → email: employee "submitted"
pending    → approved       → email: employee "approved", finance "queued for posting"
pending    → sent-back      → email: employee "needs revision" + reason
pending    → rejected       → email: employee, all prior approvers "rejected" + reason
approved   → posted (FICO)  → email: employee "reimbursement queued"
```

Every state change already exists in the prototype (`approve()`, `sendBack()`); this is a
matter of firing an event on each transition rather than new logic.

**b) Rejection reason field.** Add a required `reasonCode` + free-text `reasonNote` on the
`sendBack`/reject action — Finance enters it once, and it propagates to three places that
today show nothing: the PRRW view (Finance-facing), the approver history (so a later approver
in a multi-step chain sees why an earlier step rejected it), and the requester's own status
screen. One field, three display surfaces — worth calling out in the case study as a case where
a single data model change fixes three separate listed gaps (rows 8, 9, 10 in the source table
are one root cause, not three).

---

## 5. Per diem accuracy — recalculation on date change

**Gap:** Per diem isn't recalculated when travel dates or duration change.

**Root cause:** Per diem is calculated once at trip creation and never re-triggered — there's no
event hook on date/duration field changes.

**Where this lives:** The **policy engine** already owns per-diem logic (see
`data/policy-rules.json`, `perDiemRates`). Extend it with a recalculation trigger: any edit to
`startDate`, `endDate`, or `destination` on an existing travel request re-runs the per-diem
calculation and flags the delta to the employee ("per diem adjusted from $360 to $480 due to
2 additional days") rather than silently changing the number.

---

## 6. Budget and funds management

**Gaps covered:** No budget reservation at Travel Request approval · Fund Centre not re-derived
when Cost Centre changes · Cost Centre not derived from WBS Element · budget check incorrectly
triggers on blank Cost Centre.

**Root cause:** These four are really one theme — **funds management (FM) derivation and timing
logic** isn't wired correctly to the cost object hierarchy. Fund Centre should derive from Cost
Centre via the standard FM derivation strategy, but it's evidently hardcoded or not re-triggered
on change; Cost Centre-from-WBS derivation isn't pulling from project master data; and budget
checks are firing at the wrong stage of the process (on save/blank rather than at posting).

**Where this lives:** This is the strongest case for a genuinely new module: a **Budget &
Funds module**, sitting between the auto-coder and FICO, with three responsibilities mapped
directly to the four gaps:

1. **Cost object derivation chain** — when a WBS Element is entered, derive Cost Centre from
   the WBS's project master data (not left blank or manually entered); when Cost Centre changes
   for any reason, re-derive Fund Centre automatically. This is a derivation *pipeline*, not two
   separate fixes — get the sequencing right and both gaps close together.
2. **Budget reservation at approval, not submission.** When a Travel Request is approved (not
   at initial submission), create a budget reservation/commitment document that ring-fences the
   funds. This is the same "approval as the trigger point" pattern already used for GL posting
   in our architecture — reservation should fire from the same `approve()` transition, just
   writing to a different downstream object (FM commitment vs. FI posting).
3. **Budget check timing.** Move the check from field-level (blocks on blank Cost Centre) to
   document-level at the posting stage. Practically: the policy engine should not treat a blank
   Cost Centre as a budget failure — it should treat it as an *incomplete document* validation
   error, which is a different failure category with a different message ("Cost Centre required
   before submission" vs. "Budget exceeded").

---

## 7. Advance refund automation

**Gap:** No system process for refunding an unutilized travel advance when a trip ends early;
accounting is manual.

**Where this lives:** A **refund workflow** attached to the same posting object created for the
original advance. When a trip is marked complete with unused advance balance
(`advanceAmount - actualExpenses > 0`), auto-generate a reversing FI entry referencing the
original advance document number, and route it through the same approval router used for
regular expenses — no new approval mechanism needed, just a new *trigger* (trip closure with
positive balance) feeding the existing pipeline.

---

## 8. Per diem defaulting by grade — TRPVP feasibility

**Gap:** Per diem for meals/accommodation is maintained manually per employee in Infotype
PA0017 by grade; every grade change requires a manual HR update.

**This one is different from the rest — it's a feasibility question, not a build task.**
`TRPVP` (Statutory Group / Travel Privilege grouping) is a standard SAP HCM/Travel Management
feature that, where licensed and configured, defaults per-diem eligibility from an employee's
grade/statutory grouping automatically, removing the manual PA0017 maintenance step entirely.

Recommended framing for the case study: this is a **"assess, then decide" line item**, not a
design decision to make now. Two honest paths, and the case study should show you'd scope this
properly rather than assume:

- **If TRPVP is available and licensed:** this is a configuration exercise (map grade →
  statutory grouping → per diem table), not custom development. Low build cost, but requires an
  SAP functional consultant to confirm licensing and run the config.
- **If not available:** the fallback is what our **policy engine already does** — grade-based
  lookup tables (see `perDiemRates` and the grade-band logic in `policyEngine.js`), just
  extended to pull `JobGrade` from HCM on every relevant HR action (not only at trip creation)
  so a mid-cycle promotion updates the per-diem default without manual intervention.

---

## Summary: where each gap sits

| Theme | App-layer fix (this tool) | SAP config/feasibility (separate track) |
|---|---|---|
| G/L & audit trail | Auto-coder: stamp PostedBy/CreatedBy | PRRW field layout exposure |
| Attachment lifecycle | New: document lifecycle guard | — |
| Delegate authorization | — | Auth object remediation (Basis) |
| Notifications & rejection reason | Approval router: event hooks + reason field | — |
| Per diem recalculation | Policy engine: recalculation trigger | — |
| Budget & funds management | New: Budget & Funds module | — |
| Advance refund | New: refund workflow off posting object | — |
| Grade-based per diem | Policy engine: live grade lookup (fallback) | TRPVP licensing/config (preferred, if available) |

Six of the eight gap themes are genuine app-layer additions that extend modules already in the
architecture. Two (delegate auth, TRPVP) are explicitly *not* app design problems — they're
SAP configuration and licensing questions, and the case study is stronger for naming that
distinction rather than absorbing everything into "the tool will fix it."
