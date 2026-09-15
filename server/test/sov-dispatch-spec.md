# SOV dispatch acceptance specification

Approved scope: the user's SOV dispatch plan and explicit instruction to implement it,
including pending-pickup repair and preservation of started/completed work.
Operator, returns, MBT billing, and new NetSuite mutations are outside this change.

## Acceptance scenarios

1. An eligible Delivery SO with item lines at NetSuite location 4 is discovered by
   the regular SO feed. Existing PO/TO/inventory feed locations are unchanged.
2. Code 195 is a dispatch yard at `195 Milner Ave Unit 5, Scarborough, ON M1S 4P4`.
   Existing saved four-yard setup gains it once and retains custom settings.
3. Physical SOV stock, including loose quantities with zero pallets, requires a
   pickup at 195 before delivery. Browser and server agree. Save/reload and driver
   projection retain the pickup, cargo, and address.
4. Fee-only SOs require no stock pickup; explicit pickup overrides continue to
   work; fully allocated alternate pickups do not produce phantom native cargo.
   SOA/SOB/SOM and grouping/splitting retain their existing semantics.
5. Repair inserts/reuses pickups for pending SOV deliveries only. It preserves
   stop identities, source quantities, other orders, driver records, and started
   allocations. An in-progress travel target is also protected. Repeating a repair
   is a no-op. Unchanged legacy started routes still permit unrelated saves.
6. Repair requires the current plan revision and activity fingerprint under the
   fleet/plan locks. Concurrent driver updates cannot be lost. Rollback leaves all
   database state unchanged; committed repairs archive the prior snapshot and audit.
7. SOV02222 is Billed/Pick-Up and is not reopened. SOV02345's observed in-progress
   delivery is reported for review rather than assigned a retroactive pickup.

## Failure model and setup

Tier 3 for concurrent saved-plan repair: wrong ID/address (catalog tests), omitted
cargo or duplicate pickups (unit/property tests), retroactive edits (activity and
travel tests), concurrent driver changes (database lock/fingerprint tests), partial
writes (rollback rehearsal), stale browser assets (runtime version check).

Use existing Node 20 test images, fast-check, c8, TypeScript, ESLint, and an isolated
PostgreSQL 18 container. No dependencies, commits, credential changes, or NetSuite
transaction writes. Store baseline/evidence artifacts under ignored test-artifacts;
persist tests, reproducible runner, repair command, and evidence in the repository.
Deploy only after focused checks and relevant regression suites have no new failures.
