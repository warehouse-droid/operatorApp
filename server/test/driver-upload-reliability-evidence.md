# Driver PWA upload reliability — deployment evidence

Deployed on October 13, 2026 after the user explicitly requested "deploy the driver PWA as well". Migration 282's unique diagnostic index was built concurrently in production, verified valid, and then recorded as applied. Operational audit records were preserved.
The approved [specification](driver-upload-reliability-spec.md) is implemented. Original implementation SHA-256: `d53df1326c45eebe29aa7d408f88bbd249042e187fd7f7d2dd47697a6d4a400e`.

## Production deployment

The Driver update was deployed with the delivery-request enhancements in
`mbbs-operator-app:delivery-driver-20261013` at
`2026-10-13T22:03:51.836993+00:00`. The scoped overlay preserved the current
live application's unrelated changes, configuration, database, webhook worker,
and Ollama service. Only the Driver diagnostic import, early 16 KB parser, and
authenticated route were merged into the live server. The service worker retains
its existing later fixes and advances the Driver shell to v45. The replay harness
was excluded from the runtime overlay.

Fresh checks against this exact production candidate passed 54/54 unit,
property, and real HTTP/database tests, focused syntax/lint/types, and 8/8 mobile
fault workflows across Chromium and WebKit with no retries. These verify measured
progress, confirmed-photo retention, partial rejection/disconnection recovery,
and reconciliation after a lost save response. Live local/public health returned
200, all nine changed public assets matched their captured hashes, the Driver
version endpoint was available, and anonymous diagnostic writes returned 401.

Exact scoped source hashes and fresh checks are retained in
`server/test-artifacts/delivery-driver-release-20261013/driver/results/driver-checks.json`;
deployment, migration, and rollback records are in
`server/deployments/delivery-driver-20261013/`. The delivery-only estimate
follow-up preserves all Driver runtime hashes. The earlier validation below is
retained as historical implementation evidence, including its documented baseline
failures and execution limits.

## Investigation and resulting behavior

The baseline upload flow could wait indefinitely for upload authorization, storage, or a response body. This was reproduced with a stalled network boundary. Aurther's prior pickup saved two photo references at 07:12:38 Toronto time; the next drop started at 07:13:30 and completed at 08:13:35. That timeline does not identify the failed network operation: the original failure reason was not retained.

The PWA now shows measured current-photo progress and a byte-weighted overall percentage. Sending all bytes displays “Waiting for confirmation”; saving is a separate phase. Authorization receives 60 seconds, transfer receives its own size-based 90-second to six-minute budget, and saving receives 120 seconds. Failed attempts retain selected photos and confirmed references. A lost completion response is checked against server history before another write. Network errors retain the flag used by existing offline recovery.

Authenticated failure records persist in `delivery_audit_log` with action `driver.photo_upload.failed`, driver/device/session identity, stage, job/photo, attempt, timestamps, byte counts, percentage, duration, status, code, version and safe reason. Messages redact credentials and image data. The local queue keeps at most 100 records, reports overflow, survives disconnection, partitions by identity, and deduplicates acknowledged retries. Storage-quota denial retains an in-memory fallback. Assets use `20261013-driver-upload-v1` and shell cache v45; the logical client protocol stays unchanged.

## Fresh validation

| Layer | Result |
| --- | --- |
| Unit, property and asset contracts | 49/49 passed; 700 seeded property examples |
| Real HTTP/database audit checks | 5/5 passed; 8 simultaneous retries produced exactly one immutable audit entry |
| New upload module and diagnostic validator | 283/283 lines executed; 86.06% branches |
| Failure persistence repository | 31/31 lines executed |
| Targeted mutations | 10/10 killed; both progress mutations also killed by properties alone |
| Syntax, focused lint, diagnostic types | Passed, zero warnings/errors |
| Existing Driver regression files | 71 files; 239/246 tests passed; zero NEW failures |
| Repository types | 886 existing diagnostics (572 distinct); zero NEW diagnostics |
| Secret scan | Passed; no dependencies or lockfiles added |
| Historical server replay | 194 records, 185 physical visits, 6 consolidated visits; retry preserved photo evidence |
| Mobile browser execution | 48/48 passed with no retries |

All ten mutants were also run against the property suite alone. The eight non-math mutations survived that narrower suite and were killed by the unit/contract tests; properties establish progress invariants, not the other behaviors.

| Browser | Passed | Historical driver routes | Logical jobs completed | Fixture photos |
| --- | --- | --- | --- | --- |
| chromium-mobile | 24 | 20 | 225 | 292 |
| webkit-mobile | 24 | 20 | 225 | 292 |

## Seven-day snapshot

Source dates are October 7–13, 2026 in America/Toronto. Read-only capture: `2026-10-13T13:02:18.20145+00:00`; SHA-256 `20b02bbfdcfc8d665c986e88e5b60e2de8b2d6e84cc7b0880963eea774b7505b`. Six source drivers and six confirmed plans are represented. Today's snapshot is partial. October 11 has an empty confirmed plan; October 12 has no plan or job records to replay.

| Source date | Captured job records | Drivers with records | Confirmed plans |
| --- | --- | --- | --- |
| 2026-10-07 | 63 | 5 | 1 |
| 2026-10-08 | 47 | 5 | 1 |
| 2026-10-09 | 51 | 5 | 1 |
| 2026-10-10 | 21 | 1 | 1 |
| 2026-10-11 | 0 | 0 | 1 |
| 2026-10-12 | 0 | 0 | 0 |
| 2026-10-13 | 12 | 4 | 1 |

The server corpus replays all 194 captured records, including incomplete records. Browser cases execute all 20 assigned driver/day routes from the captured plans, which can include additional planned work beyond the captured job records. Each browser also checks visible progress, HTTP rejection, connection loss, partial retry and a lost completion response.

## Behavior-to-test mapping

- Percentages, unknown lengths, independent deadlines, cancellation, storage confirmation, HTTP/network errors, queue bounds/ownership/denial/redaction: `test/mbt/unit/driver-upload-reliability.test.js` and `test/mbt/property/driver-upload-progress.test.js`.
- Logout isolation, retained BIN slots, pre/post DVIR reconciliation, signature failure, explicit safe retry and progress rendering: `test/mbt/unit/driver-upload-lifecycle.test.js`.
- Stalled API response body, invalid successful response and preserved auth/version/device headers: `test/mbt/unit/driver-upload-request.test.js`.
- Bounded hostile diagnostics: `test/mbt/unit/driver-upload-failure.test.js`; authenticated persistence, revocation, concurrent deduplication, immutable retries and body-size rejection: `test/mbt/integration/driver-upload-failure-http.test.js`.
- Visible current/overall percentages, retained previews, retry skipping and lost-response recovery: `test/driver-upload/faults.spec.js` against the actual isolated application.
- Whole historical routes, truck switch, persisted evidence, reload recovery and route advancement: `test/driver-upload/historical.spec.js` plus `src/driver-seven-day-replay-harness.js`.
- HTML/module/cache/worker consistency: `test/mbt/unit/driver-pwa-recovery-assets.test.js`. Its version expectations were advanced to the approved new assets while retaining every consistency assertion and adding module load order.

## Existing failures and limits

The following regression failures also occur with the original source. They assert older hard-coded cache/asset generations (v41/v43) against the original v44 shell. They remain unchanged:

- S11: the guarded client ships in a new atomic Driver shell generation
- a failed staging download leaves the active and non-Driver caches byte-for-byte unchanged
- a fresh Driver shell version evicts older copy-enabled cached assets
- a fresh Driver worker reloads every v41 shell asset and initializes only its scoped sentinel
- a successful repair replaces only the complete Driver shell and preserves offline data sentinels
- the reset ships as a new atomic shell generation without forcing a protocol-version cutover
- the updated override policy is atomically included in the Driver PWA shell

Repository type errors also match the original source, including duplicate occurrences. The whole unrelated MBBS suite was not run; all existing Driver test files in unit/property/integration/adversarial/concurrency groups were run. Line coverage above applies to the new upload/diagnostic modules and repository; it is not a claim of full coverage for the legacy Driver or entire server.

The historical fixture contains no real photos or credentials. Tests use JPEG fixtures and an isolated R2 contract server, with Samsara/customer writes disabled. Direct-pickup dependencies are reconstructed from captured manifests, not a historical dependency-event timeline. Source dates are retained in reports while routes run on the current isolated company day; only the test countdown is accelerated. Browser execution uses Chromium/WebKit with mobile profiles, not physical phones. Service workers are blocked for operational replay; atomic shell wiring is verified separately. This does not validate live R2 availability, physical camera permissions or real cellular conditions. No historical logging can retroactively establish Aurther's original network cause.

Failures found during development were retained in the artifact logs: unbounded waits, incorrect floating-point percentage rounding, stale-screen completion recovery, lost diagnostics after storage quota denial, invalid durations after clock changes and lost network-error classification. Historical fixture IDs were shortened to satisfy the existing PWA limit; missing direct dependencies were seeded without weakening production guards. Four fixed fake test tokens were explicitly documented for the secret scanner; scan rules were unchanged.

## Reproduction and cleanup

Run from the repository root: `bash server/tools/driver-upload-verify-all.sh`.
The entry point runs every layer and generates this report. Existing locked dev dependencies are installed into the artifact toolchain only when absent. Recorded tool versions: `{"@playwright/test": "1.62.1", "c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "typescript": "7.0.2"}`; Node 20.20.2, browser image `mbbs-to-yard-test-browser:20261009`. The original source snapshots needed for comparison are retained under `test-artifacts/driver-upload-reliability/baseline`; the dirty workspace was preserved and no commit was created.

Every test uses `mbbs-tests.slice` and bounded memory, CPU, PID and tmpfs settings. Cleanup is registered before containers start. Each Compose stack is removed with volumes/orphans; one-off containers use `--rm`. Both `docker ps` and `docker ps -a` confirm no task-owned test containers remain. Production app/database/Ollama are healthy and the webhook worker is running. Production, rollback data and operational audit records were outside cleanup.

Machine-readable results, exact source hashes, per-layer commands/logs, screenshots, browser traces and teardown evidence are retained in `server/test-artifacts/driver-upload-reliability/`, including `final-evidence.json`, `source-tree.json`, `regression-baseline-comparison.json`, `type-baseline-comparison.json`, `browser-report.json`, `mutations.json` and the final health/container lists.
