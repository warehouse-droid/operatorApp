# Shared BIN/Dispatch planner release — 27 September 2026

Status: **deployed and verified**. Cutover started at **07:20:22 UTC** after the
user renewed the deployment instruction and preflight confirmed zero active
editors or checked in-flight operations. No edit lease was changed or revoked.

- Dispatch Planning: https://test.mbbsoperation.com/dispatch/planning
- BIN Planning: https://test.mbbsoperation.com/mbt/planning

The user previously authorized deployment. This release replaces the separate
BIN UI with the actual shared Dispatch planner and moves the BIN Planning link
to the Dispatch top bar. [Implementation evidence](bin-planner-reuse-evidence.md)
records the tests and their limits.

- Deployed tag: `mbbs-operator-app:bin-dispatch-ui-20260927`
- Deployed ID: `sha256:3417d2b959064e67bac99a7524bfaa317e9bc7d44eaedd5a899d83ead3192b12`
- Captured live/rollback ID: `sha256:37d9cdb5039f007d827119e81ea38286b3d8175f1669fa215ac0576cf85bda1a`
- Rollback tag: `mbbs-operator-app:rollback-bin-dispatch-ui-20260927`
- Frozen verification hash: `6804a9574f594493c32ab3ebd7736d33132d503d11d07db79da476098a1b996e`

The overlay changes exactly **14 runtime files**. All **1,104 runtime files**
were hashed in the prepared image against the captured production baseline plus
that overlay. The unrelated local `src/netsuite-restlet-harness.js` edit is
excluded. App/worker environment, commands and configuration are preserved.

## Completed release checks

| Check | Result |
| --- | --- |
| Exact candidate source: BIN suite | 59/59 tests, including Chromium and real HTTP confirmation |
| Exact candidate source: existing compatibility | 155/155 tests |
| Candidate app and worker images | Health 200, worker started, zero restarts |
| Candidate migration rehearsal, twice | No new migration; existing synthetic visit unchanged and no new planning event |
| Rollback app and worker images | Health 200 and worker started |
| Production migration preview | No pending migrations; existing migration 235 retained |
| Private PostgreSQL backup | 398,967,384 bytes; restore table of contents validated |
| Live app and worker | Recorded image, preserved configuration, zero restarts |
| Live assets | Seven assets each on local/public endpoints, all 14 hashes match |
| Live authenticated APIs | BIN planner, Dispatch bootstrap and shared date lease return 200 locally and publicly |
| Authentication checks | Anonymous planner and lease requests return 401 |
| Live probe business state | Daily plan unchanged; no edit lease acquired; diagnostic login/session removed |

Backup completed **07:09:27 UTC**; SHA-256
`b5bbe31c1339c281b2e2670987529c039b29dead02163d71c2de1efc7a1fde77`.
The dump and private Compose files are in the ignored owner-only release
directory and must not be committed or published. Startup rehearsal is not a
claim that every old UI workflow was tested against data written by the new UI.

The deployment runner checked for active editors and in-flight operations again
immediately before cutover, applied no database migration, and restarted only the
app and webhook worker. The database and Ollama containers were unchanged. No
rollback was required; the previous images and rollback Compose file are retained.
The receipt's migration field identifies the already-applied migration 235,
whose presence was verified, rather than a new migration in this release.

## Commands and receipts

```sh
python3 server/tools/bin-planner-reuse-release-capture.py
python3 server/tools/bin-planner-reuse-deploy.py prepare
python3 server/tools/bin-planner-reuse-release-checks.py
python3 server/tools/bin-planner-reuse-release-smoke.py
python3 server/tools/bin-planner-reuse-deploy.py preview
python3 server/tools/bin-planner-reuse-deploy.py backup
python3 server/tools/bin-planner-reuse-deploy.py apply
```

Preparation intentionally refuses to overwrite the captured release. The runner
uses the existing private Compose/environment configuration and local image/test
tooling. Receipts and runtime diffs are under
`server/test-artifacts/bin-planner-reuse-release-20260927/`, including
`capture.json`, `manifest.json`, `release-checks.json`, `release-smoke.json`,
`migration-preview.json`, `backup-result.json`, `ready-for-cutover.json`,
`cutover-start.json`, `live-probe.json` and `deployment-result.json`. Startup logs
were checked for module, syntax and uncaught errors. The broader test/type limits
remain documented in the implementation evidence; deployment does not claim
project-wide test or type cleanliness.
