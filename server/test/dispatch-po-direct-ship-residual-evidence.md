# Dispatch PO Direct-Ship Residual Routing — Evidence

Date: 2026-08-25 UTC

Status: implemented and verified in isolated containers; not deployed and no production row was changed.

## Reproduced failure

The production-shaped `SOB118279` / `SN1398699` fixture has 51 source PO pallets at approximately 75,986.231 lb. Its active Link PO allocations send 38 pallets directly to the Sales Order customer. The saved Dispatch route retained a standalone PO stop with the original 51-pallet values, so the load counted `38 + 51 = 89` pallet positions and approximately 132,071 lb.

The correct conservation is:

| Movement | Pallets | Weight |
| --- | ---: | ---: |
| Vendor pickup | 51 | 75,986.231 lb |
| Direct customer freight | 38 | 56,084.561 lb |
| Residual 3445 freight | 13 | 19,901.670 lb |

The 13-pallet residual contains 12 DUSK pallets, 1 URBAN pallet, and the corresponding 13 PALLET deposit quantity. The immutable PO source remains 51 pallets for PO Split, receiving, and SCM.

## Root cause and correction

- Link PO quantities were projected onto the Sales Order pickup, but there was no authoritative route-only residual for the linked Purchase Order.
- Dependency reconciliation added/removes vendor pickup stops, but did not add, reduce, or remove the residual PO destination stop.
- Browser and server load calculations trusted stale explicit stop values before current PO allocation evidence.
- Driver PO details could reload the full receiving lines rather than the residual plan lines.

The correction adds a `poRouteProjection` that subtracts active allocations line by line without mutating source PO quantities. The same projection now drives Dispatch browser totals, server physical visits, Driver pickup/drop details, compact snapshots, and dependency route reconciliation. Link/unlink saves the relationship and corrected route atomically. A compact plan that omitted its PO receives the exact latest PO snapshot before reconciliation.

## Scenario evidence

The executable specification covers partial and full direct shipment, no link, link extension, unlink/relink, grouped and split Sales Order targets, multiple targets on different Driver loads, multiple PO destinations, Dispatch delivery-address overrides, legacy aliases, loose quantities, decimal quantities, hostile allocation values, a pre-existing PO stop, a missing PO stop, manual/shared pickups, stale saved stop totals, and Driver detail materialization.

Key invariants verified:

- Partial link: exactly one residual yard route is retained or inserted.
- Full link: only the empty residual PO drop is removed.
- Existing stop: updated in place without moving it to another load.
- Multiple allocations: summed once per PO line and clamped at zero.
- Multi-destination PO: line destinations remain separate.
- Source PO: source items and SCM remaining quantities are unchanged.
- Safety: started-job, closed-order, receiving, stale-plan, Driver-readiness, and transaction rollback blockers remain active.

## Verification record

- Focused route suite: 37 passed, 0 failed.
- Shared dependency-management suite: 40 passed, 0 failed.
- Complete Dispatch suite: 62 files / 257 tests passed, 0 failed, including database integration and concurrency.
- Legacy route/Driver harnesses: 5 passed, 0 failed (including 96 Driver-order and 151 load-assignment assertions).
- Property test: 1,000 generated allocation/quantity examples passed.
- Coverage for `dispatch-po-route-projection.js`: 100% statements, lines, and functions; 90.44% branches.
- Mutation testing: 7/7 injected faults killed; sources restored.
- ESLint: zero warnings.
- Legacy JavaScript syntax and MBT TypeScript checks: passed.
- Secret scan: passed with no high-confidence findings.
- Source-state base commit: `8ed7d9b80dd02e5331dfda35b092fbfa4e0c2d6c`.

The first complete Dispatch run exposed one isolated-browser compatibility failure after the helper extraction. That failure was corrected; the isolated test passed 7/7 and the complete 257-test Dispatch run then passed. The legacy harness run similarly exposed missing helper/version coverage; the permanent focused suite now includes those harnesses.

## Operational handoff

No broad startup migration silently rewrites saved or issued Driver routes. After deployment, an older affected plan must be refreshed through the guarded dependency command path (or an equivalent reviewed unlink/relink) before execution. That preserves the existing Driver readiness and started-work fences. Future link/unlink actions persist the corrected route automatically.

The dedicated gauntlet project tears itself down. The shared disposable test database, containers, network, and the two exact test images were removed after final validation.
