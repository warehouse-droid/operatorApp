# NetSuite priority deployment — 2026-09-25

Deployed successfully to **both app and webhook worker at 19:42 UTC / 15:42 EDT**.
User authorization: "deploy the priority fix". Spec approval was not obtained
independently; this is an autonomous Tier 3 release of the prepared implementation.
The [specification](netsuite-priority-queue-spec.md) includes the deployment amendment.

The reported SOB121332 / IF155241 pickup had spent 96.016 of its 107.020 seconds
waiting behind the old shared SuiteQL FIFO. Operator requests now bypass that
FIFO and receive priority in the database-coordinated scheduler. This application's
upgraded app/worker share four HTTP slots, with at most one background request.
Already-running requests finish normally. NetSuite processing and other external
integrations remain outside this scheduling guarantee.

## Exact release and preservation

- App: `mbbs-operator-app:netsuite-priority-20260925-v1-app`, image
  `sha256:e4d2608291873ce24120dc174cf17954859928924b6432f046cfca4cc6ab0d1c`.
- Worker: `mbbs-operator-app:netsuite-priority-20260925-v1-webhook-worker`, image
  `sha256:62ad67b409fbed949714e7085401b3a00a97aa84a37cdf87c00468985176ad70`.
- Eight scoped files per service; unrelated source/public files and dependency
  files retained. SCM alerts, exact submission times and confirmation dates remain
  included. Runtime configuration, database container and Ollama container unchanged.
- Migration `227_netsuite_request_priority.sql` applied once after verified schema
  and migration-history backups. This adds coordination metadata only.
- Previous images retained with `rollback-netsuite-priority-20260925-v1-app` and
  `rollback-netsuite-priority-20260925-v1-webhook-worker` tags. Rollback compose
  configuration retains the additive table.

The prepared patch needed context adjustments because the app had newer receipt
recovery/Special quantity code and the worker lacked several newer app functions.
Those differences were preserved; only functions already present were adapted.
The first two preparation attempts failed safely before any production change.
Their rejected hunks are retained. Final patches, complete baseline/candidate
hashes and per-service configuration hashes are in the release manifest.

## Fresh release checks

| Check | Result |
| --- | --- |
| App priority, pickup/return, transport and neighboring posting tests | 94 passed |
| Older worker scheduler, cross-process, failure cleanup, pooling and transport tests | 24 passed |
| Changed executable lines | 221/221 covered |
| Changed branches | 89/95 covered; defensive branches remain outside measured execution |
| Types / lint against captured app baseline | Zero new diagnostics; 254/949 pre-existing diagnostics |
| Five queue mutants, example suite | 5/5 killed |
| Same five mutants, property suite alone | 5/5 killed |
| Purchase-order stale-write guard mutant | Killed |
| Randomized mixed-priority property scenarios | 24, seed 240925 |
| Shuffled focused test files | Passed, seed 250926 |
| Exact release images on isolated DB | App health 200; worker started |
| Cross-container scheduling using exact images | Operator finished while worker background callback held; observed 2 total, 1 background, 1 Operator |
| Migration replay / reservation cleanup | Passed; zero reservations after smoke |
| Both old images on upgraded disposable DB | App health 200; worker started |
| Dependency / credential-pattern checks | Unchanged dependencies; scan passed |

Toolchain: Node 20.20.2, PostgreSQL 18-alpine, c8 12.0.0, ESLint 10.8.0,
fast-check 4.9.0, TypeScript 7.0.2. No package installation or business test
transaction was needed. All release runtime hashes were checked after testing.

The full repository suite was not repeated for this deployment. The original
prepared revision had a full baseline/candidate comparison with zero new failing
tests/files and 24 retained baseline failures. This release ran the affected
tests and all scoped static, property, mutation, shuffle, actual-image and rollback
checks freshly. Full-suite preparation results remain historical evidence, not a
claim that the current entire workspace is green. No browser assets changed;
browser testing and a dependency audit were not repeated.

## Production verification

Both services passed source/image/configuration verification and remained running
with zero restarts. Local/public health returned 200; anonymous protected access
returned 401. A bounded read-only query of the existing incident IF succeeded
through each live service's scheduler:

| Service | Priority | Shared queue wait | Complete probe |
| --- | --- | ---: | ---: |
| App | Operator | 13.27 ms | 1,384.92 ms |
| Webhook worker | Background | 10.59 ms | 1,028.79 ms |

These are diagnostic reads, not measurements of a new customer pickup. At
19:43:54 UTC, there were no post-cutover pickups yet, no waiting/expired queue
entries, one background request running, valid queue indexes, zero restarts and
no scheduler/module/startup errors in the inspected logs. The existing unrelated
Dispatch workflow-lock failures are not assigned to this release.

## Reproduction and artifacts

Run the isolated release checks against retained exact source/image snapshots:

```sh
bash tools/netsuite-priority-release-verify.sh
```

Deployment entry points are in `tools/netsuite-priority-deploy.py` (`prepare`,
`build`, `check`, `apply`, `verify`, `live-probe`); applying again is guarded
against a changed live baseline. The deployment script applies only migration
227, performs an idle-work check, preserves rollback images and verifies the
coordinated restart. The standalone live probe only reads an existing IF.

Evidence directory:
`test-artifacts/netsuite-priority-deployment-20260925/`, including
`manifest.json`, per-service release patches, `release-evidence.json`,
`checks-app/`, `worker-tests.log`, `release-smoke.json`, backup manifests,
`preflight.json`, `deployment-result.json`, startup logs and `live-probes.json`.
The incident capture is in `test-artifacts/pickup-if-latency-20260925/`.
