# SOB120487 + SOB120489 load investigation

Status: investigated in isolated containers; no production deployment or live
load/unpack performed. The operator's historical minute-long incident is not
confirmed as a CO regression. Spec approval: not obtained (autonomous run).

## Actual frontend replay

The test runs the deployed `server.js` and complete Operator assets in Chromium,
clicks the real Load button, captures the screen, and uses the real authentication,
photo-ticket and group-load endpoints against disposable PostgreSQL. It recreates
orders 994321/994340 and group GOB-120487-120489 from a read-only snapshot, with
contact text removed. The packed state is reconstructed from their saved cargo:
25 pallets of item 4993, 2 pallets + 2 layers of item 1013, and 28 PALLET units.
The two original JPEG byte sizes are 3,064,255 and 3,063,668 bytes.

The database also has 13,000 synthetic SOs / 30,000 SO lines and 2,000 TOs /
6,800 TO lines, approximating the unrelated live population. It is not a full
copy of the 21 GB production database or its concurrent workload.

External photo storage is replaced by a local HTTP upload service. The network
is internal and browser requests outside localhost are blocked. Automatic
approval review rejected uploading copies of sensitive proof photos to the
external service. The fallback did not make that external write. It therefore
cannot measure the real photo service or the operator's actual connection.

| Deployed code / conditions | Observed screen completion | Local load HTTP request |
| --- | ---: | ---: |
| Current deployed code, unrestricted local upload | 2.30 s | 1.397 s |
| Pre-CO saved image, unrestricted local upload | 2.33 s | 1.189 s |
| Current deployed code, controlled 750 kbps upload | 68.02 s | 1.589 s |

The screen is sampled once per second, so completion figures are observed upper
bounds. HTTP timings are recorded from individual Playwright request events.
All three runs finish on **Load Complete / Loaded**, with two load records and
two photo references per order, no browser errors, and no NetSuite posting.

In the 750 kbps experiment the two upload requests last 65.52 and 65.39 seconds.
The local load request does not begin until 66.28 seconds after the click. The
60-second screenshot shows **Saving proof / Saving photo proof... (60s)**.
This reproduces the reported symptom under an explicitly imposed upload limit;
it does not establish that the operator's connection had that speed.

`captureCameraPhotoDataUrl`, `uploadOperatorPhoto`, `uploadOperatorPhotos`,
`mapWithConcurrency`, and `confirmFulfillment` are identical between the saved
pre-CO image and the currently deployed assets. Taking photos does not start
their upload; `confirmFulfillment` awaits both uploads before POSTing `/load`.

Artifacts in `test-artifacts/local-load-performance/replay/`:

- `deployed-normal.json`, `pre-co-normal.json`, `deployed-750kbps.json`: sanitized
  request paths/timings, sampled screen status and results; no auth headers.
- `deployed-750kbps-60s.png`, `deployed-normal-after.png`, and videos: actual UI.
- `source-manifest.json` and `pre-co-photo-comparison.json`: deployed/pre-CO
  source hashes and limitations of the reconstructed fixture.
- Private captured order/photo inputs stay in ignored artifacts, under a mode
  700 directory; the photo file is mode 600. They are not repository fixtures.

Replay, using those captured private inputs and copied deployed source:
`bash server/tools/local-load-replay-test.sh`.
Controlled upload experiment:
`LOCAL_LOAD_REPLAY_RUN=deployed-750kbps LOCAL_LOAD_REPLAY_UPLOAD_KBPS=750 bash server/tools/local-load-replay-test.sh`.
The persisted read-only export tools are `local-load-replay-export.mjs` and
`local-load-replay-photos.mjs`; run them inside the app container and redirect
their output to the private artifact inputs, never to a public log. The replay
uses the existing `mbbs-scm-search-vendor-test:20260910` image, Playwright 1.62.1,
Chromium revision 1234, and PostgreSQL 18. No package installation was needed.

Setup corrections: the first fixture export incorrectly replaced a required
JSON field with null; it was corrected to an empty object. The initial unit-test
image lacked Chromium and its shared libraries; the replay now uses the existing
browser-capable image and cached browser. Neither failure involved live writes.

## Separate local-query optimization — prepared, not deployed

Read-only profiling found `getDeliveryOrder` materializing 33,788 unrelated
outbound lines and spilling 1,123 temporary blocks. Its header query took about
123 ms per canonical read; the CO packing guard itself took 3–12 ms. The CO
checks added repeated reads and amplified an existing query inefficiency.

A two-line candidate limits both SO and outbound TO CTE branches to `$1`.
It preserves guards, locks, API results and transaction boundaries. It is not
presented as a fix for the operator's minute-long incident and remains undeployed.
Candidate source SHA-256:
`8b07d6f7d913a7e7a3858f57e140bf3df07a9077ab5bfa656ea04fca023fb896`.

Reproduce checks: `bash server/tools/local-load-performance-gauntlet.sh`.
Final fresh results for that candidate are in
`test-artifacts/local-load-performance/`:

- Baseline: 62 adjacent tests pass in both file orders. The new SO/TO query-plan
  tests fail because 33,401 rows are materialized instead of one; the original
  isolated load regression also exceeded its one-second budget.
- Candidate: 66 tests pass in both file orders. Six complete repository-call
  timings across those runs are 221–356 ms. These run inside rollback contexts
  and do not include browser/network/photo upload or a durable outer commit.
- Existing CO handoff, concurrent operator/handoff mutex, canonical row locking,
  grouped quantity/audit rollback, underpack and consolidation tests pass.
- Property: 25 generated SO/TO warning/underpack cases plus explicit boundary
  examples pass; adjacent suites retain their existing generated properties.
- Changed-line coverage: 2/2 lines. Four deliberate mutants are rejected. The
  two wrong-order mutants fail the property; the two unbounded-scan mutants
  fail query-plan constraints. The property alone does not enforce scan cost.
- Syntax and secret checks pass. Type/lint comparison has zero new findings:
  3,048 existing type diagnostics and nine existing lint findings remain.
- No dependencies, schema, public signatures, locks or production capabilities
  changed. Dependency/license audits were not rerun because dependencies did
  not change. The enormous unrelated repository suite was not run; the full
  affected five-file suite was run in both orders with baseline comparison.

Docker's default subnet pool was exhausted during the first gauntlet attempt.
The task scripts now allocate explicit small private subnets and clean up only
their own containers/networks. Other development containers were not removed.

## Remaining uncertainty

The historical request lacks end-to-end phase timing. PostgreSQL commit
timestamp tracking is off and its retained WAL no longer exposes that load's
commit record. Live read-only checks found no current blocking transaction.
The controlled upload experiment establishes that synchronous photo upload can
hold this screen for a minute; it cannot identify the historical bottleneck
without timing from the operator's actual device/network or a future occurrence.
