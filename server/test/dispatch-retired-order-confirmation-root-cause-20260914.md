# Dispatch confirmation rejects retired references — root cause

Investigated 2026-09-14 against the running
`mbbs-operator-app:unpacked-split-20260914-v1` image. This investigation used
read-only database transactions and existing application functions. No runtime
code, source order, retirement flag, assignment, or plan was changed.

## Finding

The live order feed and the plan-save validator disagree about the lifecycle of
two references. Fresh server reads return their active source records, while the
save validator rejects the same references using retired global definitions.
The client classifies these source records as belonging to the current plan and
includes them in the save payload even when they have no load assignments.

This reproduces with a fresh server read. A stale browser is not required.

| Reference | Source record returned by the feed | Conflicting global definition |
| --- | --- | --- |
| SOA08404-S2 | `sales_orders`: active, open; `dispatch_scm_so_splits`: active | `dispatch_global_order_splits.active=false`, updated 2026-09-11 17:54:15.253823 UTC |
| CO-GOA-7894-7895 | `local_co_orders.status=pending_load`, updated 2026-09-01 22:53:17.862448 UTC | `dispatch_global_order_groups.active=false`, updated 2026-09-01 22:22:47.112793 UTC |

## Causal chain

1. `listDispatchSnapshotDerivedOrders` in `src/server.js:1560` excludes retired
   definitions from the historical/derived branch of the order feed.
2. `loadDispatchOrdersForResponse` in `src/server.js:1836` separately reads
   canonical source records through `listDispatchOrders`. Its source branch
   still returns both references. `mergeDispatchOrderFeedWithSnapshotDerivedOrders`
   starts with those source rows and only adds absent derived rows; excluding a
   reference from the derived branch does not exclude its source row.
3. The SO source response lacks global-definition ownership metadata. Client
   `normalizeOrder` infers `originalOrderId` from the `-S2` suffix. The CO response
   is a direct `local_co_orders` record, not an active global group definition.
4. `isDispatchPlanOwnedOrder` in `public/dispatch.js:5829` accepts a split with an
   `originalOrderId`, or a CO, when global ownership metadata is absent.
   `planPayload` in `public/dispatch.js:5686` submits assigned **or** plan-owned
   orders. Both records therefore enter a draft without being placed on a load.
5. `reconcileDispatchPlanGlobalOrderDefinitions` in
   `src/dispatch-delivery-group-repository.js:1174` checks all submitted order and
   stop references against global definitions. With rejection enabled, an inactive
   definition without an explicit reactivation throws
   `DISPATCH_DERIVED_ORDER_RETIRED` at line 1221.

The rejection protects against restoring retired work, but the read-side and
client-side inconsistencies make the application submit a payload it will reject.

## Live reproduction

Called the deployed `loadDispatchOrdersForResponse({search: ref})` inside
`BEGIN READ ONLY` for each reference, then passed the returned orders to the
deployed `reconcileDispatchPlanGlobalOrderDefinitions` with
`rejectRetiredGlobalOrderRefs: true` and **no trucks**. No save endpoint was called.

Observed results:

```json
{"check":"fresh_server_feed","ref":"SOA08404-S2","returned":true,"type":"SO","sourceTable":"sales_orders","sourceOrderId":"","elapsedMs":16656}
{"check":"fresh_server_feed","ref":"CO-GOA-7894-7895","returned":true,"type":"CO","sourceTable":"local_co_orders","sourceOrderId":"GOA-7894-7895","elapsedMs":15814}
{"check":"validation","rejected":true,"code":"DISPATCH_DERIVED_ORDER_RETIRED","message":"Reload this Dispatch plan before saving. Retired derived order(s) cannot be restored by a stale snapshot: CO-GOA-7894-7895, SOA08404-S2.","retiredOrderRefs":["CO-GOA-7894-7895","SOA08404-S2"]}
```

The deployed browser's actual `isDispatchPlanOwnedOrder` function was also
executed against the two records in rejected recovery snapshot 17282:

```json
{"recoverySnapshotId":"17282","planId":"326","ref":"SOA08404-S2","sourceTable":"sales_orders","assigned":false,"classifiedAsPlanOwned":true,"includedByPlanPayload":true}
{"recoverySnapshotId":"17282","planId":"326","ref":"CO-GOA-7894-7895","sourceTable":"local_co_orders","assigned":false,"classifiedAsPlanOwned":true,"includedByPlanPayload":true}
```

These results establish both the server contradiction and the client inclusion
path without assuming what was visible in the user's browser.

## Timeline and saved-work impact

- The CO was cancelled on September 1 around 22:22 UTC. Audit entries show it
  was subsequently recreated at 22:52:39 UTC and placed on a load at 22:53:07 UTC.
  Its source row is active again, while the older retired global-group record
  remains inactive under the same reference.
- The split's retirement timestamp exactly matches Dispatch command 2024 on
  September 11: plan 323, `replace_plan`, revision 41 to 42. Its global definition
  still identifies source plan 322 (September 10), and its materialized SO and
  split ledger remain active. The retained command receipt does not store the
  original request payload, so the exact earlier UI gesture that requested
  retirement cannot be established from that receipt alone.
- Recovery 17279, plan 326 / September 13, at 13:14:27 UTC rejected SOA08404-S2.
- Recovery 17282, plan 326, at 13:15:17 UTC rejected both references. Neither was
  assigned to a stop in that rejected draft.
- Recovery 17288, plan 324 / September 14, at 13:17:20 UTC rejected SOA08404-S2.
  It contains 59 order records and the draft's trucks.
- At inspection, active plan 324 remained at revision 19, last applied at
  13:12:52 UTC. Its subsequent rejected edits are stored separately as recovery
  snapshots (`applied=false`), rather than applied to the active route. Plan 326
  remained at revision 16.

The error's generic instruction to reload does not resolve the underlying feed
contradiction. Recovery drafts must be retained when recovering the user's edits.

## Required correction

Use a consistent lifecycle authority across canonical feeds, derived definitions,
and save validation. Reconcile the stale source/definition conflicts explicitly,
including the direct CO that was recreated after an older group retirement.
Do not blanket-reactivate retired definitions or delete source order data.

The client must avoid treating every unassigned canonical CO or suffix-derived
split as newly owned by the current plan. Existing legitimate assignments, new
unsaved splits/groups, and explicit reactivation still need to work. Validate the
repair with a fresh-feed-to-save replay and restore the relevant recovery draft's
legitimate edits without resubmitting the conflicting references.

No corrective implementation or deployment was performed as part of this
root-cause investigation.

The subsequent requested regression, correction, replay, deployment and live
post-check are documented in [the correction evidence](dispatch-retired-confirm-evidence.md).
That follow-up also records a separate live driver allocation conflict that
arose after the original replay snapshot.
