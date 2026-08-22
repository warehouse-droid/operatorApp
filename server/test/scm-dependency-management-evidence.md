# SCM Dependency Manager — Verification Evidence

Date: 2026-08-19 UTC

Status: implemented, verified in the disposable `mbbs-mbt-p1-test` Compose project, and deployed to production on 2026-08-20 UTC.

## Outcome

- SCM writers can search the latest global normal/group/split order identities and preview/apply Link TO, Link PO, unlink, and direct-ship changes from `/scm/dependency-management`.
- A target may have multiple distinct TO dependencies. Re-linking the same TO to the same logical target extends it; moving that TO to another target remains blocked.
- Dispatch and SCM use the same atomic command, blocker, target-signature, plan-revision, and plan-digest path.
- Relationship, plan snapshot, Operator materialization, action receipt, and old-manifest supersession commit together or roll back together.
- A screen-off, suspended, stale, dirty, busy, or mismatched Driver device cannot authorize a route replacement. The request remains pending and the existing route remains usable.
- Optional Web Push contains only a generic prompt. It cannot install or authorize a route.
- The exact authenticated Driver device must be visible, online, synchronized, idle, and acknowledge readiness. Readiness lasts two minutes; SCM must then re-preview and explicitly click Apply.
- After commit, the old manifest and grant are fenced. Unexpected old events remain review evidence and cannot produce operational effects.

## Executed gates

| Gate | Result |
| --- | --- |
| Focused behavior/database/HTTP/UI suite | 36/36 passed |
| Focused ESLint | Passed with zero warnings |
| Legacy browser syntax | Passed |
| Safety mutation suite | 8/8 mutants killed; source hashes restored |
| Dependency licenses | 396 packages passed; pre-existing `buffers@0.1.1` metadata exception remains documented |
| Changed-source secret scan | 23 paths checked; no high-confidence findings |
| Migration upgrade/idempotency | 1/1 passed through migration 173 |
| Dispatch optimization/regression suite | 52 files, 205 tests passed |
| Driver PWA cache/reset/UX contracts | 36/36 passed |
| Mobile WebKit service-worker cache/reset E2E | 3/3 passed |
| Driver offline stress matrix | 320/320 passed; 0 failed; 0 missing |
| Diff whitespace validation | Passed |

## Historical replay

The anonymized 2026-08-05 through 2026-08-18 replay processed 29,334 cross-system events and compared the projection after every event:

- Dispatch events: 5,661
- SCM events: 13
- NetSuite-derived events: 16,632
- Driver events: 7,028
- Plan transitions: 843
- Projection comparisons: 29,334
- Mismatches: 0
- Causal digest: `31ccef9ea09ad0de3a454b2af6c3cf8bf753097b43bb3ac3d9fdf9184ee27310`

The historical source did not contain `splitPoLink`, `splitPoDirectShip`, or `groupPoLink`. Those three interactions, plus grouped TO and combined relationship cases, are covered by deterministic adversarial tests rather than being silently claimed as historical coverage. The replay artifact is SHA-256 pseudonymized and excludes names, addresses, photos, and raw payloads.

## Driver offline and WebKit evidence

Run: `full-seed-20260812-2026-08-19T214314-888Z`

- 48 desktop Chromium cases passed.
- 88 mobile Chromium cases passed.
- 144 mobile WebKit cases passed.
- Organic IndexedDB errors: 0.
- Deliberately injected IndexedDB/network/quota faults: 100; every passing detector retained immutable evidence and converged later.
- The eight schema-v1 WebKit recovery cases persisted `ArrayBuffer`, not `Blob`, and all passed.
- Covered 4K eight-photo captures, 20 Hz confirm/submit/next-step bursts, offline start, half-upload disconnect, 1-second-connected/10-seconds-disconnected cycling, lost responses, renderer crashes, quota pressure, cache eviction, and multi-tab/device contention.
- Source SHA-256 bound to the run: `4d83b5a025b735e838ad0edb0be30661bdf7c25e62a14f44c356d7cccd90237f`.

This is real Playwright WebKit execution with an iPhone 15 device profile, not a physical-iPhone field test.

## Reproducible commands

```sh
npm run gauntlet:scm-dependency-management
npm run test:dispatch:performance
npm run test:driver-offline-stress:full
node --test --test-concurrency=1 test/mbt/integration/migration-upgrade.test.js
```

The gauntlet intentionally requires `MBT_TEST_ISOLATED=1`; mutation testing additionally requires `MBT_MUTATION_EPHEMERAL=1` and a writable disposable source copy.

## Artifacts

- Specification: `test/scm-dependency-management-spec.md`
- Two-week replay: `test-artifacts/dispatch-planner-replay/two-week-2026-08-05_2026-08-18.json`
- Offline stress evidence: `test-artifacts/driver-offline-stress/runs/full-seed-20260812-2026-08-19T214314-888Z/evidence.md`
- Offline stress per-case results: `test-artifacts/driver-offline-stress/runs/full-seed-20260812-2026-08-19T214314-888Z/cases/`

## Deployment boundary

The user separately authorized production deployment on 2026-08-20 UTC.

- Release image: `mbbs-operator-app-app:latest`, image ID `sha256:725f0cfedeeee3f0c169f57b63f3b879d653a7e6a29c05e99f0d5302918f2bb0`.
- Rollback image: `mbbs-operator-app-app:rollback-pre-scm-deps-20260820T010143Z`, image ID `sha256:25b659c84f63cdae5789299b58821e67d367c9c902fd355377be352cb6ff64af`.
- Backup: `docker/backups/pre-scm-dependency-20260820T010143Z.dump`, SHA-256 `988e33b3c644deabda5c1329fea5f92e35f3b6445d67d4a9becfde55412a244a`.
- Production migrations 171, 172, and 173 applied successfully. The post-migration read-only preflight reported no missing migrations, no Dispatch collisions, and no feature-flag inventory corruption. Its initial-rollout-only `ready` value remained false because seven established MBT production gates were already enabled before this deployment; those gates were intentionally preserved.
- Only the application container was recreated. Docker event and application-listen timestamps bound the interruption to 1.72 seconds; PostgreSQL and Ollama were not restarted.
- The application, PostgreSQL, and Ollama containers were healthy after cutover. The Driver PWA version remained `2026.08.12.3`; offline mode remained disabled at revision 3. Dispatch Driver-oriented planning remained enabled.
- `DISPATCH_PLANNER_ORDER_POOL_MODE` and `DISPATCH_PLANNER_COMMAND_MODE` remained `off`, preserving the legacy planner until a separately authorized shadow/on cutover. The SCM Dependency Manager itself is live and authentication-protected.
- The bounded storage cleanup completed successfully, retained the three newest dumps including the deployment backup, and preserved both release and rollback images. The disposable test project and its exact test image were removed after deployment.
