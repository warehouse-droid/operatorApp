# Operator IF/IR timings, deferred photos, and receiving completion

## Result

- Operator IF/IR calls emit structured timing logs, including retries, queue waits, source preparation, transforms, verification/recovery, and local finalization.
- Captured photos are saved with the command. R2 uploads begin after verified completion, run in the server background, and retry independently. Closing the browser does not discard accepted photos.
- The posting notice uses its content height. Back to Receiving clears both searches and stale selections. Locally completed split and ordinary POs are hidden even when the cached NetSuite status is older; partial receipts remain available. Another submission from a stale screen is rejected.
- These changes were [deployed and verified](operator-improvements-deployment.md) on 2026-09-16. No live IF/IR or customer-photo upload was performed as a verification test.

Spec approval: **not obtained (autonomous run)**. The user authorized these changes; the written [specification](operator-posting-latency-spec.md) is available for review after implementation. Evidence verifies the stated cases, not every possible production condition.

## Reproduce

From `server/`, run `sudo bash tools/operator-posting-latency-gauntlet.sh`.
The entry point reconstructs the original baseline from the reversible task manifest, uses isolated PostgreSQL containers and fake external transports, runs browser checks, and finally reads SN1400333 in an explicit database `READ ONLY` transaction. The last read requires the existing production app container; it performs no writes or NetSuite calls.

The [task manifest](operator-posting-latency-changes.json) records before/after SHA-256 hashes and reversible edits. The [task patch](operator-posting-latency.changes.patch) isolates this work from the pre-existing dirty workspace. `test-artifacts/operator-posting-latency/summary.json` records the final source hash and measured results.

Toolchain: Node 20.20.2; PostgreSQL 18 Alpine; existing images `mbbs-retired-confirm-test:20260914` and `mbbs-mbt-p1-test-e2e:latest`. Existing locked dev dependencies: Playwright 1.62.1, c8 12.0.0, ESLint 10.8.0, fast-check 4.9.0, TypeScript 7.0.2. No dependency or lockfile changes.

## Specification → verification

| Scenarios | Verification |
| --- | --- |
| 1–2: every IF/IR attempt and stage timed; body included; safe concurrent attribution | `operator-posting-http-timing.test.js`, `operator-posting-latency.test.js`; four transform types, IF/IR reads, REST/SuiteQL retries and failures, serialization wait, hostile log content, logging failure |
| 3: durable photos before transform, no browser R2 wait | `operator-posting-photo-client.test.js`, `operator-posting-photos.test.js`, consolidated-load HTTP integration and browser camera workflow |
| 4: only completed owners; retry/restart/concurrency; no repeat posting | `operator-posting-photos.test.js`; six concurrent claimers, expired leases, token fencing, failed finalization, persisted backoff, unchanged completed-command/attempt count |
| 5: atomic, scoped replacement with stable command identity | `operator-posting-photos.test.js`, `consolidation-load.test.js`; rollback, unrelated proof preserved, receiving proof, native/local consolidated child records, replay after R2 replacement |
| 6: input bounds, compatibility and ownership | malformed/MIME/base64/size/count cases; 160 generated image round trips and ordered replacements; existing posting admission/domain/property/adversarial tests; driver-owned Delivery SO stays on the direct-upload path |
| 7: background timing/failure state | worker success/failure/lost-lease tests, safe persisted errors, startup polling smoke check |
| 8: compact readable notice | Chromium geometry and screenshots at 390×844, 768×1024 and 1280×900; real CSS and banner renderer |
| 9–10: completed PO absent and stale submission blocked | `operator-receiving-completed.test.js`, plus read-only candidate-code replay on actual SN1400333 / receipt 993562 (IR14634) |
| 11: cleared receiving navigation state | `operator-receiving-return.test.js`; actual browser function executed with boundary stubs; clear search/selection/suggestions/page, invalidate outstanding requests, save state, reload |
| Existing behavior / migration integrity | baseline vs full suite, exact type/lint baseline comparison, upgrade/no-op inventory through migration 201, migration rollback rehearsal, asset cache tests |

## Final measurements

Source state: `1fe2df71e6a528ed79f1d22dad592194307bade397270930490cd1157828ec6a`.

| Layer | Final result |
| --- | --- |
| Full `npm test` | 2,500 tests: 2,497 passed, 2 known baseline failures, 1 existing skip; **zero new failures** across 491 files |
| Baseline | 2,475 tests: 2,472 passed, the same 2 failures, 1 skip |
| Focused regressions | **140/140 passed**, no skips |
| Type/lint baseline comparison | Same 233 type errors and 11 existing lint errors; **zero new errors or warnings** |
| Syntax / whitespace | All changed runtime JS parses; scoped `git diff --check` passed |
| Changed backend lines | **386/386 executed**, including startup registration; per-file counts in `summary.json` |
| Manual mutation | **10/10 plausible bugs caught**; restored copies pass; the 2 parser/replacement mutants also fail the property suite alone |
| Generated cases / order | 160 generated photo round trips and ordered replacements, seed 16092026; six focused files also pass a reproducible shuffled order |
| Browser | **5/5** consolidated-load workflow tests pass, including Chromium desktop/mobile and WebKit mobile; notice geometry passes all three screen sizes at **33.59375 px** high |
| Server execution | Candidate server started on an isolated database; `/health` returned 200; background photo polling ran without worker errors |
| Actual SN1400333 | Read-only replay at 2026-09-16 01:12:34 UTC: receipt status `received`, receipt ID 993562; absent from receiving search; new receiving attempt rejected with HTTP 409 |
| Dependencies / secrets | No package or lockfile changes; task-diff credential-pattern scan passed |

The unchanged baseline failures are `P3.12: browser specs share one worker-owned database-pool lifecycle` and `quality non-regression: the gauntlet builds and validates the omit-dev runtime`.

All final layer artifacts completed. The outer long-running tool session reported exit 143; an independent rerun of `tools/operator-posting-latency-evidence.py` passed, validating the final source hashes, result counts, mutation results, and coverage. No test result is inferred from the outer session status.

## Operational use

Filter app logs for `"event":"operator_posting_timing"`, then group by `commandId` and sort by `at`. Each event includes `durationMs`, `outcome`, and the applicable transaction type, stage, operation, HTTP method/path/status, and attempt. `netsuite.http` includes downloading the response body; `netsuite.auth` measures obtaining credentials. `netsuite.queue` separates serialization wait. Larger stage timings contain their child operations, so do not add all rows together.

`photo.r2` measures each background R2 request. `photo.background` includes upload and local reference replacement. Errors include safe codes; no request/response bodies, SQL, tokens or image data are logged.

The additive migration `201_operator_posting_photo_uploads.sql` creates the durable queue. Inspect `status`, `attempt_count`, `next_attempt_at`, `last_error`, `command_id` and `batch_id` there to diagnose outstanding uploads. The worker polls every five seconds, claims at most two photos per tick, uses 120-second leases and a 60-second upload timeout, and backs off from 20 seconds to at most one hour. The original image remains available until the uploaded reference and associated proof records commit together.

## Limits and findings

- Initial photos still need to reach the app before posting. Production latency improvement has not yet been measured. The new logs supply that evidence after deployment.
- R2 failures retain pending images in the database and retry indefinitely. A crash after R2 accepts an object but before the database commits can leave an extra remote object on retry; exactly-once R2 object creation is not claimed. It cannot repeat the IF/IR.
- Photo validation checks supported MIME labels, canonical base64 and size, not full image decoding. Existing R2 references remain compatible.
- Frontend behavior is checked with the real browser and actual-function VM tests. Browser/CSS changed-line coverage is not claimed; backend changed lines are measured separately.
- The baseline contains two infrastructure test failures, 233 type errors and 11 lint errors in existing code. The checks compare exact error identities and require zero new failures; unrelated issues are preserved.
- During development, the suite caught required migration/cache expectation updates, a driver-owned Sales Order upload-path edge case, and an unrelated source-extraction contract affected by overly broad queue instrumentation. These were corrected. The consolidated browser's old upfront-R2 expectation intentionally changed with the approved task scope; its camera preservation, retry and refresh assertions remain, with a new zero-browser-upload assertion.
- Dependency audit and license audit are not rerun because dependencies did not change. The task diff is scanned for credential patterns. Capability review: the server worker now uses the existing signed R2 upload service; no new endpoint, credential, external service, runtime subprocess or arbitrary filesystem access is introduced.
