# Direct shipment lifecycle correction (Tier 3)

Authorization: user requested the fixes and replay of all direct-ship SOs with linked TOs/POs. Spec approval: not obtained (autonomous run); the scenarios below are available for review while work continues.

## Acceptance scenarios

1. A fully allocated PO linked to an SO, group or split has no separately plannable cargo. Its card explains the linked target. Both its vendor reference and original PO reference are rejected by incremental, replacement, full-save and confirmation planning paths. Existing executed history remains readable.
2. A partially allocated PO retains exactly its unallocated native and physical quantities. Pickup alone, or only one of several required SO deliveries, cannot complete the whole PO. All required deliveries produce one effective completion with actual Driver evidence. MBBS-Special native quantity remains authoritative.
3. A direct TO with 20 pieces allocated 19 pieces to an SO exposes exactly one piece for its remaining route. Completing the SO records only 19 pieces received and does not mark the whole TO Completed. The remaining route can be planned and delivered; completion then requires both portions. Fully linked TOs remain unavailable for independent planning.
4. Full direct TO delivery completes the TO; a partial delivery does not. Quantities are capped at actual active source cargo, handle native quantities and mixed display units, and remain nonnegative. Cancelled relationships do not reserve cargo.
5. Repeating online/offline completion, or two competing completion calls, produces one receipt and never increments received quantity twice. Route identity, completed-job proof, source cancellation/hold and executed-history protections remain enforced.
6. Historical incorrect partial-TO completion is excluded with auditable evidence, without deleting immutable completion events or disturbing legitimate later Driver/reconciliation/manual evidence. Migration is repeatable and compatible with the rollback application.
7. Replay every direct-to-customer dependency and every PO-linked SO present in one captured production snapshot, reporting active and cancelled links separately. Check each applicable planning, quantity, delivery and idempotence invariant. Records without historical Driver proof are exercised as simulations in the clone and labelled accordingly; they are never represented as real completed deliveries.

## Failure model and validation

- Duplicate transport or hidden remaining cargo: exact UI/feed and persisted command assertions; generated quantity conservation properties; all-record production-copy replay.
- Premature completion: partial/full tests, several SO targets, both delivery orders, cancelled links, real online/offline Driver endpoints.
- Double receipts / stale concurrent planning: database transaction/race tests and command guard tests under the existing fleet lock.
- Incorrect historical repairs: preview, immutable-event assertions, legitimate alternative evidence preserved, migration twice, rollback rehearsal on an isolated clone.
- Regression outside these cases: baseline comparison against captured current source, full MBT and related dispatch suites, randomized ordering, lint/types with zero new diagnostics, changed-line coverage and manual mutants including property-only runs.

## Setup and invariants

Use existing Node 20/PostgreSQL 18 Docker tooling and pinned project test dependencies; add no packages. Capture the current dirty worktree as a baseline without changing existing work or imposing commits. Add focused tests, replay/validation scripts, a migration and an evidence report. Production reads and a database backup support replay; all simulated deliveries and quantity mutations run on disposable internal-only databases with external writes disabled. Preserve SO/TO/PO source references, source NetSuite records, completed Driver jobs, photos, immutable events and executed route history. No API signature changes or new network capabilities.

## Additional constraints established during validation

- Native receipt quantities must be capped when a source TO was reduced after linking, and must not add inventory already received through NetSuite.
- A TO group must not bypass direct-link protections or reconstruct a partial TO's full source cargo. While linked, remaining TO quantities are planned using the TO's own remaining-cargo route.
- Both the current vendor reference and original PO reference remain blocked after the last partial-PO route completes.
- A residual native piece is displayed using available unit conversions (20 pieces / 2 pallets minus 19 linked pieces leaves 1 piece, not 0.1 pallet). If native quantity is missing but physical cargo is known, that cargo remains visible and plannable.
- Release recovery refreshes the derived planner catalog from current source data, so corrected historical completion and remaining-cargo rules reach cached cards as well as server guards.
- Historical completion entries discovered by replay are rebuilt only from existing completed Driver evidence. Recovery must match the isolated replay exactly, be idempotent and leave Driver records and received stock quantities untouched.

## Live verification clarification

NetSuite updated the corrected TOs while the release catalog refresh ran. Three acquired new, independent Received reconciliation evidence; TOB01129 became Pending Receipt. The existing fulfilled-TO policy labels fulfilled cards Completed while separately keeping their undelivered cargo eligible for Dispatch. The initial deployment check incorrectly treated that label as proof of a local Driver completion. Preserve this existing policy: a corrected TO without alternative completion must have no effective local completion; a fulfilled, unrestricted TO must keep its residual planning eligibility, and its SCM schedule must not claim a completed delivery. Independent later reconciliation evidence remains authoritative as required by scenario 6. Runtime acceptance assertions above are unchanged.
