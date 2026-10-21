# SCM Ultimate Urgent load packing — executable specification

Date: 2026-10-05. Assurance: Tier 3 (purchase/transfer planning).
Authorization: the user requested the enhancement and replay of saved plans.
Spec approval: not obtained (autonomous run); the requested priority rule is
implemented without another permission round. This document is the reviewable
specification, with correspondingly lower confidence than an independently
approved executable specification.

## Accepted behavior

1. Within a compatible pickup/type/route group, pack Ultimate Urgent pallets
   together before introducing lower urgency items. Keep a destination's
   Ultimate Urgent quantity in one load when its complete gross weight fits
   one truck. Whole partial urgent destination groups may share a route when
   they fit without splitting those groups and obey the stop limit.
2. Full Ultimate Urgent loads contain only Ultimate Urgent material lines.
   Full means another whole urgent pallet cannot fit; unused space smaller
   than an urgent pallet is allowed. Only partial urgent loads may receive
   lower urgency material. Physical PALLET weight counts toward capacity.
3. Full Ultimate Urgent loads precede partial/mixed Ultimate Urgent loads in
   the proposal list within existing manual/replenishment priority classes.
   Destination priority and urgency score remain subsequent tie-breakers.
4. Truck count may increase to honor this stronger priority. Report every
   replay's before/after count; do not revert to fragmented packing merely
   to keep the previous count. Continue preserving full lower-priority
   destination loads when doing so does not fragment urgent quantities.
5. Conserve required, proposed, residual, and sales quantities, product and
   physical pallet weight, and destination allocations. Preserve configured
   stop limits/order and previously determined partial/hub routing.
6. Without Ultimate Urgent lines, preserve the existing packing behavior.
   Preserve PO/TO signatures, manual/replenishment priority, fractional
   purchase support, and invalid-input errors. Repeated and reordered inputs
   must obey the same urgent grouping rule.

## Named acceptance scenarios

- Full urgent loads resist lower-priority filler: capacity 30; seven Ultimate
  pallets of weight 9 and six normal pallets of weight 3 produce two pure
  urgent full loads of weight 27 and one mixed urgent remainder of weight 27.
- Truck-count preference cannot undo urgency: capacity 10; six Ultimate
  pallets of weight 1 and three normal pallets of weight 8 keep all six
  urgent pallets together even if four trucks replace three.
- Same-destination urgent quantity that fits one truck stays together, using
  the captured BWS Woodbridge -> 2967 quantities from plan 429 as regression
  input, along with all other captured compatible source groups.
- Entire urgent remainder groups may combine across destinations when their
  sum fits and maxDrops permits; a one-drop rule keeps them separate.
- PO hub/partial routing survives urgent grouping; physical pallets count;
  fractional stocking purchases conserve quantities.
- Full urgent proposal cards precede mixed urgent cards even when the latter
  have a higher score or earlier destination priority. Manual/replenishment
  priority remains ahead of ordinary loads.
- Property cases conserve all quantity/weight dimensions, enforce capacity
  and stops, protect full urgent loads, and concentrate any urgent
  destination quantity whose gross weight fits one truck.

## Failure model and checks

| Failure | Required evidence |
|---|---|
| Urgent quantities fragment or normal pallets enter full urgent loads | RED regressions, captured-plan replay, property tests, manual mutations |
| Pallets disappear/duplicate or allocations change | Per-item/destination conservation, fractional/allocation properties, existing conservation suites |
| Trucks overload or routes break | Gross-weight/stop/order checks across every replay and generated cases |
| Display ordering hides full urgent loads | Browser-script VM contract tests, runtime readback |
| Unrelated existing behavior changes | Baseline/candidate affected SCM suites and no-Ultimate replay comparison |
| Candidate includes unrelated dirty workspace changes | Capture live runtime, scoped overlay, source hashes |
| Test resources harm the application or persist | Standard isolated Compose, shared slice, bounded resources, pre-registered teardown, ps/ps-a and volume/network verification |
| Saved execution or live orders are accidentally changed by replay | Read-only capture, offline replay inputs, disposable test DB only |

## Setup and delivery

Use Node's existing test runner, fast-check, TypeScript, ESLint, and coverage
tools. Add no dependencies or schema migrations. Do not stage unrelated
workspace changes or create checkpoint commits. Capture the deployed source
and up to twenty recent ready inventory plans into existing test-artifact
storage; replay their saved proposed quantities under frozen current route
rules. This validates packing, not a reconstruction of historical forecasts.
Persist a single test entry point, mutation script, fixture, source manifest,
and evidence report. Release only the validated runtime overlay over the
current application image, retaining rollback artifacts and verifying app
health and unchanged dependencies. Existing issued orders and saved plans
are evidence inputs; the new rule applies to subsequent planning/recalculation.

## Replay fixture clarification (append-only, 2026-10-05)

The first historical replay found a saved line with proposed quantity seven,
confirmed quantity four, and residual quantity three. The planner intentionally
initializes new load confirmations to zero and residual to proposed. Before
replay, normalize these post-planning confirmation fields in the offline input
to that initial planning state, record the affected line count, and continue
checking residual conservation against the normalized input. Retain the raw
capture. No live plan or issued order is modified by this normalization.

Tests use current workspace harness loaders over both runtime snapshots and a
fresh disposable database clone per test file. This corrects stale deployed
test-loader assets and prevents fixture data leaking between test files;
behavioral assertions remain unchanged.

## Allocation fixture clarification (append-only, 2026-10-05)

The expanded generated fixture initially used `direct` for an allocation's
fulfillment value. The existing contract accepts `vendor_direct` and
`transfer_later`, and normalizes unsupported values by physical destination.
Correct the fixture to use the canonical `vendor_direct` value. Allocation
conservation assertions remain unchanged; runtime normalization is unchanged.
