# Dispatch PO reference projection consistency evidence

Status: GREEN, deployed, and production-audited on 2026-09-01 UTC.

## Incident and root cause

- At 2026-09-01 13:19:18.477960 UTC, the visible reference for NetSuite PO
  `POB03498` changed to `3022007227`.
- The legacy reference rewrite updated 37 active historical Dispatch snapshots
  and incremented all 37 plan revisions, but did not refresh their assignment
  or relation projections. Every affected `source_revision` was one revision
  behind its plan.
- `dispatch_order_catalog_state.assignments_ready` remained true. The recurring
  full catalog worker trusted that cached flag and skipped the real projection
  backfill.
- Cross-date assignment safety correctly failed closed. Consequently, adding
  `SN1399547` to Sety / Load 2 was rejected with
  `DISPATCH_ASSIGNMENT_PROJECTION_NOT_READY`; the submitted edit was retained
  as unapplied recovery snapshot `16566`.

## Immediate recovery

- The existing idempotent backfill repaired all 37 stale plan projections and
  returned `projected: 37`, `remaining: 0`, `ready: true`.
- The initial repair did not apply the dispatcher draft and did not alter
  active plan `265`. At the first cutover, plan 265 remained confirmed at
  revision 70, its projection remained revision 70, and its active snapshot
  had no `SN1399547` order or route assignment.
- A later dispatch action applied `SN1399547` to plan 265 at
  2026-09-01 16:21:22 UTC, before the invariant-hardening cutover. Plan 265 is
  now confirmed at revision 80, its projection is revision 80, and exactly one
  active assignment projection exists for `SN1399547`.
- Recovery snapshot 16566 remains unresolved and contains `SN1399547` in both
  its order collection and route. It is retained as incident evidence, but it
  must not now be replayed blindly because the order is already active.

## Permanent correction

- A PO reference rewrite now takes the shared fleet-planning advisory lock,
  locks every matching plan and snapshot row, and updates the snapshot,
  content digest, plan revision, assignment projection, projection revision,
  and relationship edges in the same database transaction.
- Projection synchronizers accept the caller's transaction executor while
  retaining their existing default API.
- Every recurring full Dispatch catalog refresh now checks and repairs actual
  projection drift instead of trusting a cached `assignments_ready` value.

### Assignment-readiness invariant hardening

- The field recurrence proved the warning was not a real startup warm-up.
  Confirm, reopen, and grouped reconciliation could commit a newer active plan
  revision while relying on a best-effort after-commit projection callback.
  That callback could deadlock, leaving the derived index stale indefinitely.
- Confirm, reopen, grouped reconciliation, plan creation, and the existing save
  paths now synchronize assignment and relation projections inside the same
  transaction while holding the shared fleet-planning lock.
- Migration `193_dispatch_assignment_projection_invariant.sql` adds a
  statement-level trigger that invalidates cached assignment readiness after
  any insert, delete, revision update, or status update on `dispatch_plans`.
  This covers future writers that do not yet know how to update projections.
- Catalog reads and ready transitions prove live plan/projection revision
  parity instead of treating the cached readiness bit as authoritative.
- Assignment commands perform a locked repair and recheck before returning a
  business result. The repair commits even when the requested order is then
  rejected as already planned, so a generic warming response cannot hide a
  real duplicate result or leave the system stale.
- The recurring ten-second catalog pass now runs the idempotent projection
  backfill even with an empty refresh outbox. The deadlock-prone after-commit
  callback was removed.

## Verification

- RED reproduced the exact revision mismatch and stale-ready suppression before
  implementation.
- Final focused suite: 42/42 checks passed across two contracts and 40 isolated
  database tests in six files.
- Changed-line execution probes: 10/10 passed.
- Mutation score: 5/5 critical mutations killed (100%); the disposable source
  copy was restored exactly.
- ESLint and syntax checks passed with zero warnings/errors. Static typing held
  at zero new diagnostics over four documented unrelated baseline diagnostics.
- Secret scan passed; dependency licenses passed for 396 packages with the
  existing `buffers@0.1.1` metadata exception unchanged.
- Full Dispatch suite: 441/447 tests passed across 92 files. The six failures in
  five files were reproduced identically against the previously deployed image,
  establishing zero new full-suite failures.
- The exact immutable release image independently passed the focused 42/42
  checks against the isolated database.

### Invariant-hardening verification

- RED: the new invariant suite failed all 5 scenarios before implementation:
  a direct writer left readiness true, the getter trusted the stale bit, an
  idle recurring tick did not repair, and confirm/reopen/reconciliation left
  stale projections.
- GREEN: 46/46 focused checks passed across seven files; changed-line coverage
  was 19/19 and all 14 critical mutations were killed.
- Migration upgrade/readiness checks passed 7/7. Lint, syntax, secret scanning,
  and the dependency-license gate passed; static typing introduced zero new
  diagnostics over the four documented unrelated baseline diagnostics.
- A paired full-suite audit ran the same current tests against the candidate
  and the previously deployed immutable image. Both had the exact same five
  assertions fail in four files, establishing zero new full-suite failures.
- The immutable hardening image independently started against an isolated
  database with `ready=true`, `projected=0`, and `remaining=0`.

## Cutover and production proof

- Image: `mbbs-operator-app:dispatch-po-ref-projection-20260901T151705Z`.
- Image digest:
  `sha256:bd20e367847e90d4e4ae4006bebdd78feecc9ca4ea19a6117b646d41d3801c9c`.
- Source-state hash:
  `5772af6eafcb5eccbe298e8bb7babd4434d0f9eb328fdac0b59fb6c965776136`.
- App-only cutover completed in 7.03 seconds. The database and webhook worker
  were not restarted. HTTP `/health` returned 200 and the container is healthy.
- Startup reported `Dispatch assignment projection ready=true; projected=0;
  remaining=0`.
- Post-cutover production audit: zero active plan/projection revision
  mismatches; catalog status ready; `assignments_ready=true`; no catalog error.
- Rollback file:
  `/tmp/mbbs-dispatch-po-ref-projection.rollback.compose.yml`, targeting
  `mbbs-operator-app:stock-request-to-line-edit-20260901T041251Z`.

### Invariant-hardening production cutover

- Migration 193 applied successfully; production now records 194 migrations
  through `193_dispatch_assignment_projection_invariant.sql`, and trigger
  `trg_dispatch_plans_invalidate_assignment_projection` is enabled.
- App and webhook worker switched together to
  `mbbs-operator-app:dispatch-assignment-invariant-20260901T171546Z`, digest
  `sha256:7644805f0d93d65905c8051c20ea3a44289fc3c811d235c24cf95dcde5cd31f7`.
  The container replacement command completed in 2.38 seconds; the app was
  healthy at the first check and HTTP `/health` returned 200.
- Startup reported `Dispatch assignment projection ready=true; projected=0;
  remaining=0`. Repeated production checks found zero active revision
  mismatches, catalog status `ready`, `assignments_ready=true`, no catalog
  error, and no pending/failed/running catalog refresh work.
- The observed POB03658 and named child schedule rows were byte-for-byte
  unchanged across this cutover. `SN1399547` belongs to split parent POB03669,
  and its active plan-265 assignment predates this deployment.
- Rollback file:
  `/tmp/mbbs-dispatch-assignment-invariant.rollback.compose.yml`, targeting the
  two exact images that ran before this cutover.

Recovery snapshot 16566 remains preserved, but dispatch should not replay it
as-is: `SN1399547` is already active once on plan 265. A future edit will now
receive a repaired, authoritative business result instead of a stale generic
warm-up response.
