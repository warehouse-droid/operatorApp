# Dispatch PO Direct-Ship Residual Routing — Executable Specification

Approval: not obtained as a separate review checkpoint; the user requested an autonomous investigation and fix.

Tier: 3 — an incorrect projection can overload a truck, duplicate PO freight, omit a yard receipt, or publish a wrong Driver route.

## Failure model

| Failure | Required detector |
| --- | --- |
| Linked PO quantity remains on the standalone PO route and is counted twice | Unit projection test and the SOB118279/SN1398699 regression fixture |
| A partial direct shipment omits the remaining PO cargo or its yard drop | Route-reconciliation unit tests |
| A full direct shipment leaves an empty yard stop | Full-allocation unit test |
| Multiple links subtract the same freight incorrectly or create duplicate stops | Aggregate-allocation and idempotency/property tests |
| Grouped or split Sales Order targets lose their link identity | Group/split target-ref tests |
| Multiple PO destinations are collapsed into one yard | Multi-destination projection/reconciliation test |
| Link/unlink drifts quantities after repeated reconciliation | Idempotency and unlink-growth tests |
| A pre-planned/manual PO stop is duplicated or moved to the wrong load | Existing-stop tests for same and different loads |
| SCM PO source balance is reduced by a Dispatch-only link | Source-order immutability assertion and existing PO Split regressions |
| Browser and server calculate different pallets/stops | Frontend contract plus server physical-visit tests |
| Driver pickup detail shows only the residual PO cargo | Pickup/detail regression: full source PO at vendor, residual only at destination |
| A started Driver route is modified | Existing shared-blocker and Driver-activity regression suites |
| A failed snapshot save commits only the relationship | Existing injected rollback test |

## Acceptance scenarios

1. **Production regression.** A 51-pallet PO with 38 pallets direct-shipped to a grouped SO projects 13 residual pallets (12 DUSK + 1 URBAN), one 3445 drop, and approximately 19,901.670 lb residual weight. The combined vendor pickup is 51 pallets/approximately 75,986.231 lb, never 89 pallets/132,071 lb.
2. **Partial link route.** If the target is assigned and the PO has no stop, add one deterministic residual PO drop immediately after the target drop and reuse the required vendor pickup.
3. **Existing stop.** If that PO is already planned, update its existing stop in place; do not duplicate it or move it between loads.
4. **Full link.** If all PO quantity is allocated, project zero residual freight and remove the now-empty residual PO drop while preserving the direct target route.
5. **No link.** A PO without active allocations remains unchanged and receives no derived stop.
6. **Aggregate links.** Multiple active allocations, including allocations to multiple targets, are summed once per PO line and never produce negative quantity.
7. **Group and split targets.** The visible `dispatch_target_ref` owns the direct route for normal, grouped, and split SO targets; child references remain available as evidence.
8. **Multiple destinations.** Residual lines remain grouped by their current PO line destination and retain the Dispatch delivery-address override.
9. **Unlink/relink.** Removing or extending an allocation grows or shrinks the residual projection exactly once; rerunning reconciliation is byte-stable.
10. **Loose and sales-only lines.** Pallets/layers/sections/pieces/sales quantity and line weight are independently clamped and rounded without floating-point residue.
11. **Source invariant.** `order.items`, `order.pallets`, and SCM receiving/split balances keep the full outstanding PO; route-only residual fields drive Dispatch load/drop calculations.
12. **Safety invariant.** Manual/shared pickup stops are preserved; existing started-job, closed-order, receiving, stale-plan, offline-evidence, and rollback blockers remain unchanged.
13. **Pickup evidence.** A residual PO route displays the full source PO quantity at the vendor pickup, while its own-yard drop displays only the unallocated residual.

## Setup and gauntlet

- Use the existing Node test runner, ESLint, TypeScript config, c8, fast-check, and manual mutation pattern. Add no runtime dependency.
- Add focused projection, reconciliation, frontend contract, and physical-visit tests before implementation and observe RED.
- Run focused tests, relevant Dispatch/SCM integration suites, typecheck, lint, changed-line coverage, property tests, and manual mutants.
- Perform one read-only comparison against the saved SOB118279/SN1398699 plan. Do not mutate production data and do not deploy.
- Preserve the dirty worktree and create no git commit.

## Clarification 1 — legacy pickup-weight fallback

Location-scoped item weight must take precedence when item evidence is present. A final whole-order fallback remains required for old saved manifests that do not contain item weights; the fallback itself is not a defect.
