# BIN Planning deployment — 27 September 2026

The user explicitly authorized deployment after reviewing the implementation
result. The app and webhook worker were switched at **04:33 UTC**; live
verification completed at **04:33:28 UTC**.

- BIN Planning: https://test.mbbsoperation.com/mbt/planning
- Dispatch Planning: https://test.mbbsoperation.com/dispatch/planning
- Image: `mbbs-operator-app:mbt-bin-planning-20260927`
- Image ID: `sha256:37d9cdb5039f007d827119e81ea38286b3d8175f1669fa215ac0576cf85bda1a`
- Previous image: `sha256:b352ee38fbbd03e4c6ebfe1b96283ff603e1ff763eb42602a20c7377d8959cd2`
- Rollback tag: `mbbs-operator-app:rollback-mbt-bin-planning-20260927`

The release overlays exactly **28 verified runtime files** on the captured
production image. All **1,102 captured runtime files** match the built image.
The unrelated local `src/netsuite-restlet-harness.js` change was excluded.
No dependency installation or feature-gate change was required; both BIN gates
were already enabled. App/worker configuration was preserved. The database and
Ollama containers were not restarted.

## Verification

| Check | Result |
| --- | --- |
| Exact candidate source, feature suite | 42/42 tests, including real Chromium navigation, ordinary Dispatch save with MBT disabled, shared lease and races |
| Exact candidate source, BIN/driver/Front Desk compatibility | 155/155 tests |
| Actual candidate images | App health 200; worker started; no startup module/syntax errors |
| Migration rehearsal | Existing synthetic successor released exactly once; all other existing visit fields, requested windows and assignments preserved |
| Repeat migration | No duplicate application or pool event |
| Actual rollback images after migration | App health 200 and worker started |
| Production readiness | No active Dispatch editors or in-flight checked business operations before migration/cutover |
| Live health and assets | Local/public health 200; 7 assets checked on each endpoint, 14 matching responses |
| Live authenticated endpoints | BIN planner, Dispatch V2 bootstrap and shared date lease each returned 200 locally and publicly |
| Authentication | Anonymous BIN planning and date-lease requests rejected with 401 |
| Business state during live probes | Daily plan unchanged; no edit lease acquired |
| Diagnostic access | Temporary operator and session removed in `finally` |
| Final container state | App healthy, worker running, both on the recorded image with zero restarts |

The broader implementation test limitations remain documented in
[implementation evidence](mbt-bin-planning-evidence.md): four Dispatch assertions
also fail with BIN behavior disabled, and the full imported TypeScript graph
has existing diagnostics. Deployment verification does not claim that the
entire project's tests or types are clean.

## Migration and recovery

`235_mbt_bin_planning.sql` was the only pending migration. It was applied in a
transaction with a five-second lock timeout and a thirty-second statement
timeout. Production had **zero existing successor visits** eligible for its
pool-release backfill, so none were rescheduled or assigned by the migration.

A private full PostgreSQL backup was created and its restore table of contents
validated before cutover: **398,911,022 bytes**, SHA-256
`567ad420d28750a0d3bcba8319cef1e0bf74418d8aada25b06b9a154d6f5646a`.
The backup is under the ignored, owner-only release artifact directory. It must
not be committed or published.

The previous image and generated rollback Compose override are retained. The
deployment command automatically restores the old app/worker images if its
verification fails. Migration 235 is retained on application rollback; that
combination was rehearsed in isolation. No rollback was required in production.

## Reproduction and receipts

Persisted deployment tools:

1. `python3 server/tools/bin-planning-release-capture.py`
2. `python3 server/tools/bin-planning-deploy.py prepare`
3. `python3 server/tools/bin-planning-release-checks.py`
4. `python3 server/tools/bin-planning-release-smoke.py`
5. `python3 server/tools/bin-planning-deploy.py preview`
6. `python3 server/tools/bin-planning-deploy.py backup`
7. `python3 server/tools/bin-planning-deploy.py apply`

Preparation intentionally refuses to overwrite an existing release. These tools
depend on the recorded local images, private Compose/environment configuration,
and implementation verification artifacts. They do not publish environment
secrets in their output. The capture's read-only flag and lease inspection is
recorded separately in `readiness.json`.

The initial migration rehearsal compared a JavaScript ISO timestamp with
PostgreSQL's equivalent JSON timestamp representation and failed on formatting.
Both snapshots now use PostgreSQL JSON; the full unchanged-field assertions
remain. The corrected migration, startup and rollback rehearsal passed before
production changed. Its RED log is retained.

Receipts are in `server/test-artifacts/mbt-bin-planning-release-20260927/`:
`capture.json`, `manifest.json`, `release-checks.json`, `release-smoke.json`,
`migration-preview.json`, `backup-result.json`, `migration-result.json`,
`live-probe.json`, `deployment-result.json`, and per-step logs. Private Compose
configuration and database backup files remain in that owner-only directory.
