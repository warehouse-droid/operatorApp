# Driver historical completion and completed-stop photo evidence

Evidence date: 2026-09-02 UTC

## Implemented behavior

- Dispatch can filter completed physical visits by driver, status, stop type, photo state, completion source, and free-text order/location search.
- Existing completed-stop photos are read-only. New evidence is append-only, requires a reason and explicit confirmation, and is capped at 20 canonical photos per physical visit.
- Historical completion and completed-stop append both accept either a file picker or an actual browser drag/drop `DataTransfer` flow. Draft photos and the reason survive a remote update, but submission remains blocked until Dispatch revalidates against the new immutable state hash.
- Supplemental evidence is request-bound JPEG data, uploaded at concurrency two, appended atomically across every member of a physical visit, and recorded in an immutable ledger/audit event.
- Reopening a completed physical visit retains its canonical photos; retained evidence is exposed to the Driver online/offline job and counts toward the configured completion requirement.

## Automated evidence

- Focused executable specification: **52/52 passed** (unit, property, adversarial, integration, concurrency, migration, wiring, and retained-photo tests).
- Browser drag/drop E2E: **6/6 passed** for historical completion and completed-stop append on desktop Chromium, mobile Chromium, and mobile WebKit. The completed-stop test uses `DataTransfer` to drop a JPEG, appends it, then proves an in-memory dropped draft and reason survive a cross-computer event and must be revalidated.
- Complete Node/PostgreSQL regression: **2185/2185 passed** across 437 files.
- Deterministically shuffled regression, seed `2026082001`: **2185/2185 passed** across 437 files.
- Driver offline stress campaign: **320/320 passed** (15 contract cases, 40 Node/PostgreSQL named cases, and 280 real-browser cases). See [the generated stress evidence](../test-artifacts/driver-offline-stress/runs/full-seed-20260812-2026-09-02T040419-574Z/evidence.md).
- Focused changed-module coverage: **93.93% statements/lines, 80.23% branches, 100% functions**. Machine-readable result: [coverage summary](../test-artifacts/driver-pwa-historical-assist/coverage/coverage-summary.json).
- Critical mutation score: **11/11 killed (100%)**, followed by a green restored-source run.
- TypeScript check, strict focused ESLint, secret scan, dependency tree, license gate, package JSON validation, shell syntax, and bounded `git diff --check`: passed.
- Source-state fingerprint after the final run: `69a2150ac7dfb6a021a610cf63ea01df788fe3420cf3a0b202a5e305f5a202b7` at repository HEAD `39cf22656d3dc4c7b536681878867ba137bb0f1b`.

## Test boundary

Predeployment verification ran in the isolated MBT Docker project with NetSuite writes disabled. Mobile WebKit is Playwright emulation, not proof from a physical iPhone. The later production deployment is recorded below.

## Production deployment — 2026-09-02

Deployment completed at `2026-09-02T04:44:07Z`.

- Runtime source fingerprint: `095cb909df0417c0fd48e6a3d3bf53998bf0859f99a614a1cacafa550bf52a96`.
- Immutable release: `mbbs-operator-app:completed-stop-photos-20260902T042854Z`, image `sha256:2737e6e4e27cc175ae276451c9b3fdc77d78f8504e401eacd2a6160f102428b0`.
- Rollback image: `mbbs-operator-app:rollback-before-completed-stop-photos-20260902T042854Z`, image `sha256:13f9a9ef3ee387fca1124c994e990c15bf8c52042360fcfb4898b229cd071e96`. The rollback Compose override is `/tmp/mbbs-completed-stop-photos.rollback.yml`.
- Protected database backup: `docker/backups/mbbs-before-completed-stop-photos-20260902T042854Z.dump`, 253,107,572 bytes, mode 600, SHA-256 `a6c3207f187a7af554b3d3f9adeef452e26751addf231279bcf475084dae6512`.
- The container and host backup hashes matched, `pg_restore --list` passed, and the complete archive restored with `--exit-on-error` into a network-isolated PostgreSQL 18 disposable volume. The restored database was 2,578 MB and contained all 194 pre-cutover migrations through migration 193; the supplemental-photo ledger was correctly absent. The disposable container and volume were removed.
- The read-only candidate preflight reported only migration 194 missing, zero Dispatch collisions, and the already-active MBT production flags. No live flag was disabled or changed for deployment.
- App and webhook worker stopped together with zero other active or idle-in-transaction database sessions. Migration `194_driver_completed_stop_photo_evidence.sql` applied once under five-second lock and fifteen-minute statement timeouts. Production now records 195 migrations; the new ledger exists, begins empty, and has its immutable trigger enabled.
- All 13 active production feature flags were identical before and after migration. The post-migration audit had no missing migrations, Dispatch collisions, missing flags, unexpected flags, or duplicate flags. The legacy closed-gates preflight remains intentionally `ready:false` solely because seven operational MBT flags are active.
- App and webhook worker moved together to the exact release image in 10.312 seconds. Both have zero restarts, are not OOM-killed, and have no container error. PostgreSQL retained container ID `0b1ead419efa57e4a4faa7cdad0adfa9eafcbbf90d94019942be70eaa86c88b5`, start time `2026-08-14T13:14:47.59677958Z`, and zero restarts.
- Dispatch and PO catalogs are ready with no error, `assignments_ready=true`, and zero active or idle-in-transaction database sessions. No webhook inbox failure or delayed-status-refresh failure was created after cutover; the pre-existing delayed-refresh failed/retry rows were last updated before deployment.
- Local and public `/health` returned `200` with `{"ok":true,"app":"MBBS Yard Server"}`. The public Dispatch Driver-PWA page returned `200`; unauthenticated completed-visit APIs returned `401`. Public assets expose cache key `20260902-completed-stop-photos-v1` and the completed-stop drag/drop marker. Every checked local HTTP asset was byte-identical to the immutable release image.
- Startup logs show the webhook worker running, Dispatch assignment projection ready with zero remaining rows, and the application listening normally. No production photo append, Driver action, NetSuite write, or synthetic data mutation was performed during smoke verification.
