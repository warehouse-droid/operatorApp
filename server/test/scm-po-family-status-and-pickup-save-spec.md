# SCM PO family status isolation and split pickup save specification

## Approval and production boundary

The user explicitly requested a fix, deployment, and a recalculation of only
`POB03774`, and reported the intended pickup for exact split `3022143273` as
`PERMACON Milton`. Separate approval of this executable specification was not
obtained; the agent proceeded autonomously within that narrow request. One
revision-guarded consistency repair of that exact split is authorized so its PO,
schedule, split metadata, and event ledger agree. No broad SCM reconciliation,
NetSuite write, receipt edit, quantity edit, split/unsplit, group/ungroup,
Dispatch plan edit, Driver completion edit, or unrelated catalog repair is
authorized.

## Production witnesses

At the read-only baseline on 2026-09-03 UTC:

- `POB03774` is an active, partially received source PO. Its exact SCM schedule
  and reconciliation projection are `Queued`; it has remaining source quantity
  and no exact canonical completion.
- Active child `SN1399024` has exact canonical Driver completion. Active child
  `SN1399025` is `Queued`. An older `SN1399025` split header is cancelled and
  must not re-enter the active family calculation.
- The indexed catalog stores `POB03774` as `Queued`, but the runtime status
  overlay returns it as `Completed` by borrowing `SN1399024`'s completion from
  `linkedRefs`.
- Split `3022143273` stores `PERMACON Bolton` on the purchase order and split
  metadata. Its shared schedule stores `PERMACON Milton` only because the user
  later saved the PO/TO Schedule page. The PO Split page did not call the split
  pickup mutation, so no immutable `pickup_changed` split event exists for the
  attempted PO Split edit.

## Required behavior

1. Canonical completion is exact-identity evidence. A completed child, sibling,
   group member, corresponding PO ref, or search ref must never complete another
   catalog row.
2. A source PO with remaining quantity and an exact `Queued` reconciliation
   target remains `Queued` when one child is completed. The completed child
   remains `Completed`, and an unfinished sibling remains at its own exact
   status.
3. True aliases of the same non-split purchase order (the displayed dispatch ref
   and original NetSuite PO ref) may continue to share status evidence. Existing
   linked-alias status behavior must not regress.
4. Both indexed list and indexed detail reads must enforce the same completion
   isolation. Repeated reads are idempotent.
5. On an editable split PO, the existing PO Split **Save Schedule** action must
   persist a changed pickup through
   `PUT /api/dispatch/scm/purchase-order-splits/:ref/pickup` before saving the
   remaining shared schedule fields.
6. The pickup mutation must carry the loaded split revision. Its authoritative
   returned revision must be used by any subsequent split mutation in the same
   save, and its schedule timestamp must be used by the schedule save when the
   endpoint returns one.
7. A successful split pickup save must durably update the split purchase order
   route, shared SCM schedule, split details, and immutable split change event;
   it must trigger targeted SCM and Dispatch refresh so Dispatch observes the
   new pickup without a second edit in PO/TO Schedule.
8. An unchanged pickup makes no pickup mutation. A changed source-PO pickup
   continues through the ordinary schedule path and is not treated as a split
   mutation.
9. A stale split revision or operational lock fails closed without silently
   reporting the pickup as saved.
10. Existing split destination-save behavior, status/remark saves, ref changes,
    split quantity edits, unsplit behavior, alias status precedence, and exact
    Driver/manual completion precedence remain intact.

## Targeted POB03774 recalculation

1. Run the normal reconciliation service first as a rollback-only dry run for
   exact PO family `POB03774`, including terminal members so the completed child
   is preserved.
2. The proposed family must include the current active `SN1399025` header and
   exclude the cancelled predecessor as an allocation target.
3. Apply only if the dry run is unambiguous and conserves family quantity. The
   committed result must keep `SN1399024` completed, keep unfinished quantity
   non-completed, and leave zero open review cases introduced by the replay.
4. Run a second exact-family replay to prove idempotence.
5. Refresh only the affected SCM/Dispatch catalog refs and verify backend stored
   state plus live runtime list/detail projections after event processing.
6. Record before/after witnesses demonstrating that unrelated reconciliation
   families, completions, plans, splits, groups, receipts, and NetSuite mirror
   quantities were not mutated by the scoped operation.

## Targeted 3022143273 pickup consistency repair

1. Re-read the active split immediately before mutation and proceed only if its
   split revision and current route still match the witnessed stale state.
2. Apply `PERMACON Milton` through the same normal split-pickup repository
   service used by the HTTP endpoint. Do not directly edit individual tables.
3. Verify the purchase-order route/address, shared schedule, split metadata,
   immutable `pickup_changed` event, and both SCM/Dispatch read projections all
   resolve to `PERMACON Milton`.
4. Refresh only refs belonging to `3022143273`; do not alter its quantities,
   status, plan assignment, destination, or source PO.

## Failure model and controls

| Failure mode | Executable control |
| --- | --- |
| Child completion leaks through broad `linkedRefs` | Integration fixture with queued parent, completed child, and queued sibling on indexed list/detail |
| Alias support is removed while fixing family leakage | Existing display-ref/original-ref linked precedence regressions remain green |
| PO Split visibly changes pickup but saves schedule only | Frontend request-sequence test requires pickup endpoint then schedule endpoint |
| Stale schedule revision follows pickup transaction | Frontend test requires the authoritative pickup timestamp on the second request |
| Split pickup changes only one backend projection | Repository integration verifies PO route, schedule, split JSON, and event in one transaction |
| Exact live split changed after the baseline read | Revision-guarded `3022143273` repair fails closed before any write |
| Cancelled duplicate split re-enters calculation | Exact POB03774 dry-run witness enumerates active targets |
| Broad or unsafe production mutation | Exact source ref, pre/post scope witnesses, backup, immutable image, health check, and idempotent replay |

## Assurance tier

Tier 3 evidence is required: RED regression witnesses, focused unit/frontend/
integration tests, relevant property/adversarial tests, mutation checks for the
new decision logic, strict lint/typecheck, changed-line coverage, secret scan,
source-state restoration, full relevant regression suite, backup, immutable
release image, app/worker health, and post-deploy live verification.

No new runtime or development dependency is permitted.
