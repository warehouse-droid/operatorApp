# Dispatch reconciliation-completed planning evidence

Date: 2026-09-08 UTC

## Accepted behavior

- A PO/TO split child whose receipt reconciliation says `Completed`, but whose operational MBT schedule is still pending and has no real Driver completion, remains searchable and planable in Dispatch.
- Reconciliation projection evidence alone is not presented as a Dispatch/Driver completion.
- After Driver completes the stop, the child becomes terminal for planning and retains the Driver photos.
- Dispatch can append supplemental photos to that completed visit without replacing the original Driver photos.
- Genuine operational completion, manual/preserved completion, Hold, hidden, review-blocked, and non-MBT orders remain restricted.

The executable specification is in `dispatch-reconciliation-completed-planning-spec.md`.

## Root cause and fix boundary

Explicit Dispatch search and plan-save validation treated every calculated PO/TO `Completed` state as an operational completion. Reconciliation also publishes a completion projection, so a receipt-reconciled but never-dispatched child was incorrectly made search-only and rejected during plan saves.

The fix adds a bounded eligibility query for requested PO/TO refs. It only grants the exception when the reconciliation target is completed while the exact operational schedule is still nonterminal MBT work, and when neither Driver nor another non-reconciliation completion exists. The same predicate is used by search hydration and the authoritative plan-save guard. Completion response decoration keeps reconciliation projection metadata separate from operational completion evidence.

## RED and GREEN evidence

- RED: the HTTP integration fixture failed because a reconciliation-only completed target returned `dispatchPlanningRestricted: true`.
- GREEN: `SCM restricted-order DB/API integration harness passed.`
- GREEN: `SCM restricted-order role and final-response visibility harness passed.`
- GREEN: focused lifecycle suite passed 2/2:
  - planable before Driver completion;
  - real plan guard accepts it;
  - Driver completion records two original photos;
  - eligibility disappears after Driver completion;
  - real plan guard rejects it after completion;
  - supplemental Dispatch photo append preserves the originals.
- Negative controls passed for operational completion, manual/preserved completion, Hold, hidden, review state, and non-MBT method.
- The bounded production-shaped query completed in about 14.6 ms (`EXPLAIN ANALYZE`; about 5.4 ms planning), avoiding a projection warm-up dependency.
- Scoped `git diff --check` passed.

The broader isolated test run passed all Driver split-isolation, focused lifecycle, photo-evidence, manual split-authority, and stale-destination tests. One pre-existing POB lifecycle scenario remained incompatible with the current executed-prefix baseline because it attempts to replace already completed activity on today's plan; this change does not touch that repository or policy.

## Production replay

Read-only replay for `SN1399744`, both from the candidate image and again inside the live app:

```json
{
  "orderRef": "SN1399744",
  "sourceOrderRef": "POB03774",
  "operationalScheduleStatus": "Queued",
  "reconciliationApplicationStatus": "Completed",
  "reconciliationEvidenceType": "reconciliation",
  "driverCompleted": false,
  "dispatchReconciliationPlanningEligible": true,
  "dispatchPlanningRestricted": false,
  "dispatchCompletionStatus": "",
  "planningGuardAllowed": true
}
```

## Deployment evidence

- Cutover completed: 2026-09-08T20:40:40Z.
- Deployed image: `mbbs-operator-app:dispatch-recon-pending-20260908-v1`.
- Deployed image ID: `sha256:1faf054ec6913314491e7fe3344fc07dbfa61e1687d130b0a3b97b79d773e51f`.
- Rollback tag: `mbbs-operator-app:rollback-before-dispatch-recon-pending-20260908`.
- Rollback image ID: `sha256:ada4ac9ce709f8af5058ea31c56021e8cb54efd045f4e8e79953d59807647eae`.
- Only the app and webhook-worker were recreated; both are running on the new image and the app reports healthy.
- Local health response: `{"ok":true,"app":"MBBS Yard Server"}`.
- Live Dispatch HTML serves `dispatch.js?v=20260908-reconciliation-pending-v1` and the live bundle contains the `Reconciled · dispatch pending` state.
- Post-cutover normal static and HTTP integration harnesses passed against the deployed image.
- No migration or production data rewrite was required.
