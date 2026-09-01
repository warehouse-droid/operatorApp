# Dispatch completed-CO prerequisite and group identity evidence

## Incident and acceptance target

- Production plan `263` (2026-08-30) contains completed local transfer children `CO-SOA07510` and `CO-SOA07512` under the legacy wrapper `GOA-7510-7512`.
- The Driver PWA completed the transfer to yard `12441`; migration 191 projected both physical child CO rows to `completed`.
- `SOA07512` is a separate customer-delivery leg and must remain plannable from `12441` without requiring the completed transfer card to remain visible.
- Grouping CO cards first and grouping source orders before initializing one CO must converge on the same public identity: `CO-GOA-7510-7512`.
- Executable specification: `test/dispatch-co-group-identity-spec.md`.

## RED evidence

The production preflight and pre-implementation tests reproduced both faults:

- the current plan snapshot retained `GOA-7510-7512`, type `CO`, with children `CO-SOA07510` and `CO-SOA07512`;
- both authoritative `local_co_orders` rows were `completed`, but the snapshot's embedded children still said `pending_load`;
- the order-pool payload omitted the transfer lifecycle status, so the browser treated the intentionally hidden completed CO as missing;
- the backend sequence validator searched only visible plan stops and likewise rejected a completed prerequisite;
- the focused RED run produced **15 tests: 8 passed and 7 failed**;
- the database completion integration produced **5 tests: 3 passed and 2 failed**;
- the repair integration produced **1 expected failure** because no canonical repair existed.

## Implemented invariants

- The authoritative `local_co_orders.status` is carried through both Dispatch feed paths as `transitCo.status`.
- The optimized order catalog retains a bounded `transitCo` projection (`id`, yards, lifecycle status, source identity, and timestamps) without copying raw nested payloads.
- Only `completed` and `received` satisfy a hidden transit prerequisite; pending, planned, loaded, cancelled, and missing rows remain blocked.
- The backend and mirror validators query the database and do not trust stale or spoofed client status.
- CO + CO grouping creates `CO-GOA-...`; mixed CO/non-CO grouping fails with `DISPATCH_CO_GROUP_MIXED_TYPES`.
- Stale saves and read/restore paths canonicalize legacy all-CO wrappers.
- Startup repair runs under the fleet-planning advisory lock and atomically updates the current snapshot, digest/count metadata, assignment projection, relation projection, and delivery-group projection.
- Repair preserves plan revision and saved time, embedded stable stop/job IDs, Driver evidence, archived snapshot bytes, and existing audit rows.
- Aggregate wrappers made from physical CO children are not mistaken for a third local CO. A directly initialized `CO-GOA` whose children are source orders remains a physical CO and still requires its local row.
- Repair is collision-checked and idempotent, with one audit row per identity mapping.

## Focused GREEN evidence

- focused frontend/unit/property/database packet: **26/26 passed**;
- randomized identity properties: **100 generated cases per property**;
- identity module coverage: **100% statements, lines, and functions; 97.77% branches**;
- mutation score: **10/10 killed (100%)**, followed by a green unmutated restoration run;
- targeted ESLint with zero warnings and TypeScript checks: passed;
- fresh database migration replay through migration 191: passed;
- corrected Phase 3 gauntlet ownership contract: **10/10 passed**.

## Production preflight

The read-only preflight was executed inside a read-only transaction:

- plan `263` remained confirmed at revision `25`;
- `CO-SOA07510` and `CO-SOA07512` were both authoritative `completed`, from `2967` to `12441`;
- the current wrapper was exactly `GOA-7510-7512`, type `CO`, on `BC71838 / Load 6`;
- its exact current stop references were legacy, while the stable stop IDs included one UUID ID and one historical ID containing the legacy display identity;
- current assignment and relation projections used the legacy wrapper;
- 17 archived checkpoints existed and 2 contained the legacy reference;
- there was exactly one active legacy all-CO wrapper, zero mixed CO/non-CO wrappers, zero canonical target collisions, and zero prior repair audits.

The deployment verifier must prove that only current semantic projections change to `CO-GOA-7510-7512`; stable IDs and archived bytes must remain unchanged.

## Full regression and deployment

The first production cutover completed in **7.70 seconds** and atomically repaired the one active legacy wrapper:

- startup logged `GOA-7510-7512->CO-GOA-7510-7512` exactly once;
- plan `263` remained confirmed at revision `25`, with the same `saved_at`, truck/load placement, child COs, and stable stop IDs;
- all 17 archived checkpoints remained byte-for-byte unchanged;
- Driver job, correction, assist, rest, truck-switch, and actual-arrival evidence checksums remained unchanged;
- one and only one `dispatch_co_group_identity_repaired` audit row was written.

Post-cutover verification then exposed a final fast-read seam: the full repository order correctly carried `CO-SOA07512 = completed`, but `compactDispatchOrderCard()` omitted `transitCo`. The production-shaped RED test failed with `card.transitCo === undefined` before that code was changed. The bounded compact projection and database catalog regression were then added.

Final pre-cutover evidence after that correction:

- planner optimization packet: **75/75 passed**;
- CO identity/completion packet: **26/26 passed**;
- broad Dispatch performance coverage gate: **127/127 passed**;
- optimizer coverage: **100% statements, lines, and functions; 93.72% branches**;
- optimizer mutation score: **10/10 killed (100%)**, including the mutant that discards completed transit-CO evidence;
- targeted ESLint and TypeScript checks: passed;
- fresh isolated full suite: **429 files / 2,124 tests passed**.

The final production cutover completed in **7.36 seconds**. Deployed image IDs were `1e1ea3cf6159` (app) and `c907322bf95f` (webhook worker). Live verification proved:

- `/health` returned HTTP `200` with `{"ok":true,"app":"MBBS Yard Server"}`;
- the optimized `SOA07512` card now carries `transitCo.id = CO-SOA07512`, `status = completed`, `fromYard = 2967`, `toYard = 12441`, and `pickupLocations = [12441]`;
- the catalog is `ready`, source `startup`, with no refresh error;
- the backend sequence validator returns no conflict even when the probe supplies a deliberately stale client status, because it trusts the terminal database row;
- both `CO-SOA07510` and `CO-SOA07512` remain authoritative `completed` from `2967` to `12441`;
- plan `263` remains confirmed at revision `25`; its wrapper is `CO-GOA-7510-7512` with the same two children and the same two stable stop IDs;
- startup repair is idempotent: the repair audit count remains exactly `1` and the second startup performed no additional rewrite;
- final service logs contain no startup, catalog refresh, or worker error.
