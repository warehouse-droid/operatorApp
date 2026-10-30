# Dispatch planner audit — 2026-10-30

Scope: `/dispatch` planning page — group, ungroup, split, unsplit, resplit,
group-after-split, Link TO, Link PO, and route/timing staleness.

Method: code reading only (four parallel read-only reviews plus direct tracing).
No code changed, no tests run, nothing reproduced yet.

Tags: **verified** = re-checked directly in code; **traced** = followed through
the code by a reviewer, not re-checked; **likely** = plausible, needs a repro.

Line numbers refer to `server/public/dispatch.js` unless a file is named
(paths relative to `server/`).

## Incident: plan 373 (2026-10-30) cannot save

Symptom: any save (e.g. moving Dao Load 3 to Load 1) fails with
"Draft backed up separately, but not applied to the active plan:
GOA-10724S1-10878S1 does not require pickup at 2967."

Root cause: `GET /api/dispatch/v2/bootstrap` (`getDispatchV2Bootstrap`,
`src/dispatch-planner-v2-repository.js`) returned `assignedOrderSnapshots`
straight from the stored snapshot without
`refreshDispatchPlanAuthoritativeOrderProjection`, unlike
`GET /api/dispatch/plans/:id`. The stored snapshot still held direct TO link
300 (TOB01264, yard 2967) as active, although links 300/301 are cancelled.
The browser therefore believed the group needed 2967 and kept its explicit
2967 pickup (CC46868 Load 2); the server rebuilds relationships before
validating and rejected it. Every save failed, so the snapshot was never
rewritten. The earlier dependency-pickup/cache deployments fixed the catalogue,
order feed and dependency commands but not this startup path; their browser
tests injected state directly and never exercised bootstrap.

Fix: bootstrap now runs the same authoritative projection refresh (stored
digest/revision unchanged). Tests: integration
`test/dispatch/integration/dependency-pickup-cache.test.js` (bootstrap case)
and headless Chromium `test/dispatch/frontend/dependency-pickup-cache.browser.test.mjs`
(reproduces the rejection with stale data; clean data saves and drops the
2967 stop). Pre-existing failures unrelated to the fix: billed SO HTTP save,
SOA07894 event replay, split-date-conflict classic/v2 saves.

## Fix status (follow-up, 2026-10-30)

Each fix was reproduced by a failing test first, then fixed until green.

| Finding | Fix | Tests |
|---|---|---|
| Priority 1–2: stale route legs | `estimateForLoad` ignores an estimate whose visited places (count, address, route location) differ from the current stops; stop times and labels keep it. Toll toggle invalidates the saved estimate too. | `test/dispatch/frontend/route-estimate-staleness.browser.test.mjs` |
| Priority 3: rejected save stuck | Rejected saves (409 business conflict, 202 recovery draft) show "Undo last change" and "Discard unsaved changes" (reloads the saved plan). Ungroup refuses a load the driver already started. | `rejected-save-recovery.browser.test.mjs`, `ungroup-driver-activity.browser.test.mjs` |
| Priority 4: grouped split deactivated | Confirmed-plan materialization collects splits inside groups, keeps them active and materializes never-confirmed grouped splits. | `test/dispatch/integration/grouped-split-confirmation.test.js` |
| Priority 5: regroup cancels PO links | Regroup asks before removing the old group's PO links (shared check with Ungroup; a failed check still leaves the groups unchanged). | `regroup-po-links.browser.test.mjs`, existing `dispatch-ungroup-po-warning.test.js` |
| Priority 6: parent TO link gates every split | Replenishment links apply to a split (or group of splits) only when it carries a linked item; enrichment, plan validation, driver start and client splits share one rule. Direct-pickup links unchanged. | `test/dispatch/integration/split-dependency-scope.test.js`, `test/dispatch/unit/split-dependency-scope.test.js` |
| Grouping pickups | Pickups after the grouped drop merge into an earlier same-yard visit or move ahead of it; removing/ungrouping keeps shared pickup visits. | `group-pickup-placement.browser.test.mjs` |

Replay found the grouped-split deactivation already happened in production:
`SOA10724-S1/S2` and `SOA10878-S1/S2` (plan 373) are inactive and are restored
by the next confirmed save once the fix is deployed.

Pre-existing failures (identical before and after these fixes): 53 tests across
the 32 dependency/delivery suites, `dispatch-first-split-group-status`,
`dispatch-pickup-address` (SOA09326), `dispatch-repeat-pickup-visits` RP-08.
The `dispatch-authoritative-retirement` harness was missing
`withSavedDependencyProjection` and is fixed.

## Priority fixes

1. **Route times go stale after almost any stop edit** (verified).
   `estimateForLoad` (9073) returns the cached Google estimate without checking
   it still matches the stops; `loadStats` (9365) applies `legMinutes[i]` by
   position. `commitPlanMutation` (7962) never invalidates, nor do drag/drop,
   reorder, remove-stop, optimize, clear-load, add/delete-load. Moving one stop
   shifts every later arrival, including later loads of the same driver.
2. **Stale timing is persisted and used downstream** (verified/traced).
   `trucksWithTimingMetadata` (6425) computes `loadStats` with the stale legs
   and saves `plannedStartMinute` / `plannedFinishMinute` / per-stop timing.
   The server trusts these for load assignments, monitor/forecast and driver
   handoff jobs (`src/dispatch-load-assignment.js:74`,
   `src/dispatch-forecast-service.js`, `src/driver-repository.js:659`).
3. **A server-rejected save leaves the board stuck dirty** (verified).
   On a 409 business conflict `savePlanToServer` (7320) sets
   `localPlanDirty = true` and returns without rollback; every later autosave
   fails until the change is undone by hand. Client-allowed changes the server
   rejects: ungroup a driver-started group, ungroup/split an order with a direct
   TO link, group a split with a direct TO link.
4. **Confirmed-plan saves deactivate split orders inside a group** (verified).
   `materializeDispatchSplitOrders` (`src/delivery-repository.js:3223`) only
   reads top-level `plan.orders`; a grouped `SO123-S1` is treated as omitted
   and deactivated / its split cancelled while still being delivered.
5. **Regrouping silently cancels the old group's PO links** (verified).
   `confirm-group` (17583) retires the replaced group with no warning;
   retirement cancels all its PO allocations
   (`src/dispatch-delivery-group-repository.js:1514`). Plain Ungroup warns.
6. **A TO linked before a split blocks every split child** (verified).
   `dispatchDependencyOrderRefs` (`src/yard-dependency-structure.js:20`)
   includes `originalOrderId`, and `validateDispatchPlanDependencies`
   (`src/order-dependency-repository.js:4936`) falls back to the canonical SO,
   so the parent's link gates every split, even ones without the linked item.
   The split's Link TO modal does not show the link; only escape is
   unsplit → unlink → split → relink.

## Routing / stale routes

- Load-lane moves, insert load/return, change load driver add or remove the
  start/handoff leg and shift every leg by one (10423, 16400, 17842-17875,
  18303) — no invalidation (traced).
- Group and toll toggle delete `routeEstimates[id]` but not the saved
  `load.routeEstimate` (15850, 17968); after reload the old misaligned legs
  return (traced).
- Grouping leaves an extra pickup after the group drop:
  `[pick A, drop A, pick B, drop B]` → `[pick G, drop G, pick G]`;
  `cleanupOrphanPickupStops` (10152) has no position check (verified).
- Removing/ungrouping an order that is the representative `orderId` of a shared
  pickup deletes the whole pickup (`removeStopsForOrders` 10782); it is then
  re-created right before the other order's drop, adding backtracking
  (verified).
- Group drop always uses the first selected order's address; no check that
  grouped orders share an address (verified).
- Return-yard change keeps the old drive time (18518) (traced).
- `applyVerifiedDispatchSourceRefresh` / `applyDispatchSourceDecisionResult`
  (12066, 12092) change addresses/pickup yards without route invalidation;
  `captureOperationalLoadSignatures` misses PO/direct pickup manifests and child
  source yards (traced).
- Fix direction: reject estimates whose leg count / stop signature does not
  match current stops; diff per-load stop signatures in `commitPlanMutation`
  and call `invalidateDriverRoutesFromLoad` for changed loads; use
  `discardRouteEstimateForLoad` for group and toll toggle.

## Group / ungroup

- Ungroup has no driver-activity check (group does) (16061) → looks done, save
  then rejected (see priority 3) (verified).
- "Add Group to Selected Load" never uses the selected load; group is placed
  only if a member was already on a load (15815) (verified).
- Group vs Ungroup button depends on which order was clicked first (12640)
  (verified).
- Ungroup is aborted with "Unable to check PO allocations" on any failure:
  save failure, member closed in NetSuite, group with no item lines (16028)
  (traced).
- Ungrouped children keep old `dispatchPlanned/PlanId/PlanDate` (unlike
  Unsplit, 15666) → stale "already planned on X" until pool refresh (likely).
- Ungrouping a group planned on another date retires it and deletes the other
  plan's assignment rows (likely).
- Regrouping the same orders on another date keeps the old owner plan; reload
  overwrites the new date's copy (traced).
- Snapshot restore refused after any ungroup/regroup/unsplit with
  `DISPATCH_DERIVED_ORDER_RETIRED` ("Reload…" does not help)
  (`src/dispatch-plan-repository.js:1704`) (traced).

## Split / unsplit / group after split

- TO unsplit misses grouped or other-date siblings: `splitSiblingsForOrder`
  (6891) scans top-level orders only; server does not require the whole split
  family → duplicate quantity or stop on a deactivated ref (verified/traced).
- Split inside a group gets no global split definition; a later resplit can
  reuse its suffix → every save fails "conflicting copies of the split"
  (likely).
- Grouping one split child blocked by a sibling's direct TO link (likely).
- Grouping two sibling splits merges their lines in Link PO (same parent line
  key) → false "open quantity is only X", doubled display (traced).
- Unsplit errors say "Cannot split…" / "before splitting…" (traced).

## Link TO

- Unsplit/resplit leave replenishment links on the retired split ref; restored
  SO cannot see or relink that TO (traced).
- Ungroup releases a multi-SO link to the first SO only; other SOs lose TO
  gating and can deliver before the TO arrives (traced).
- Open quantity counts links on the exact ref only; modal hides SO-level links
  while the card says "Requires TO" (traced).
- `packed` direct links block grouping while mode change/unlink accept
  `packed` (15729, `src/yard-dependency-structure.js:12`) (traced).
- `open-to-link-modal` date check: global groups have blank plan date, so it
  opens anywhere and mode change/unlink fail with `PLAN_MISMATCH`; mirrored
  plans keep stale `groupPlanId` → false "belongs to the other plan" (traced).
- Unlink does not refresh the TO card; TO stays hidden until a later pool
  refresh (17273) (traced).

## Link PO

- Open quantity counted per target
  (`src/dispatch-order-target-repository.js:284`): same SO line can be linked
  again through its group or split; Operator then blocks with
  `LINKED_QUANTITY_EXCEEDS_TARGET` (verified).
- PO links and direct TO links on the same line never checked against each
  other (traced).
- Snapshot built before retired links are cancelled → PO stays hidden until the
  next save (traced).
- Every save failure in the PO modal shows "Save the split before linking its
  PO" (17448).

## Checked and fine

- TO unsplit does not cause a "plan changed" conflict: snapshot rewrite is
  deferred while the dispatcher holds the edit lease.
- Late Google route responses are discarded if stops changed.
- Ungroup then regroup with the same ID in one session works.
- Splitting an SO that has PO links is correctly blocked.
