# Waitlist enhancements: review and validation

The SCM waiting list now supports combined selling-yard, vendor, item and customer filters, ascending/descending sorting, a Reject action on each row, and the three most recent queued source/split PO references with ETA. Reject requires a reason, closes remaining demand, returns unused reservations to their existing pools, preserves converted SO quantities, and gives Sales an unread rejection notice. Retries cannot duplicate the rejection or stock return. An active SO conversion blocks rejection.

Sales Delivery conversion asks for method and a valid delivery date. The date maps to NetSuite `custbody4` (“To be delivery by”), and method maps to `custbody3`. The payload omits address overrides and delivery notes. Native customer pricing and unit handling remain covered by the existing tests.

**Deployed with the PO lifecycle fix on October 2, 2026 at 16:28 UTC**, after the user instructed “deploy with shortover with the waitlist change as well”. This supersedes the earlier “do not deploy first” hold. A fresh live-source capture and strict rebase preserved all 12 previously tested enhancement hashes and the later production changes. The combined candidate passed all 118 PO/TO tests, all 63 waitlist feature tests and the same 63 waitlist tests in shuffled order. The [live release result](../deployments/po-status-waitlist-20261002/result.json) confirms local/public health, all six enhancement assets and protected routes. The [cutover record](../deployments/po-status-waitlist-20261002/cutover.json) reports 8.849 seconds of observed interruption. App configuration and the worker, database and Ollama containers were preserved; rollback was prepared. The earlier [hold record](../deployments/regular-waitlist-enhancements-20261002/hold.json), [scoped patch](../deployments/regular-waitlist-enhancements-20261002/changes.patch) and [candidate manifest](../deployments/regular-waitlist-enhancements-20261002/manifest.json) remain as historical review evidence. The separate workspace SCM stylesheet-order change is preserved.

The changes use the [old-coder skill](/home/ubuntu/.codex/skills/old-coder/SKILL.md), Tier 3, because rejection affects reservations, authorization and concurrent SO creation. The user directly requested these enhancements; **spec approval: not obtained (autonomous run)** for the expanded [scenarios 19–25](regular-waitlist-spec.md). The original approved specification remains recorded. Its Delivery address/contact/window requirement is explicitly superseded only for waitlist conversion.

## Recorded checks

The completed machine-readable gate is [checks.json](../test-artifacts/regular-waitlist-enhancements-20261002/checks.json). The tested candidate has source digest `1b319f7b116422a7ae4fe39e0474095fd9e1c937c43b5628ebdf19617c82286a`. The staged manifest matches its final validation hashes. The separate SCM stylesheet movement in the workspace is outside this recorded candidate.

| Layer | Result | Evidence |
| --- | --- | --- |
| Feature tests, actual staged candidate | 63 passed across 11 files; no failed, cancelled or skipped tests | [Focused log](../test-artifacts/regular-waitlist-enhancements-20261002/release-focused.log) |
| Shuffled feature tests | Same 63 passed, seed 261002 | [Shuffled log](../test-artifacts/regular-waitlist-enhancements-20261002/release-shuffled.log) |
| Properties | Six properties, 400 examples each, seed 261002 | [Ledger properties](mbt/property/regular-waitlist.property.test.js), [list properties](mbt/property/regular-waitlist-list.property.test.js) |
| Changed executable lines | 133/133 covered; scoped branch coverage 181/189 | [Coverage JSON](../test-artifacts/regular-waitlist-enhancements-20261002/release/changed-lines.json) |
| Mutation checks | All 18 killed: 11 original safeguards plus seven enhancement bugs. The two list mutants also fail property tests alone. | [Original mutants](../test-artifacts/regular-waitlist-enhancements-20261002/release/mutations.json), [enhancement mutants](../test-artifacts/regular-waitlist-enhancements-20261002/release/enhancement-mutations.json) |
| Static checks | Nine JS files parsed; zero lint findings; zero new type diagnostics (701 baseline, 700 current) | [Static log](../test-artifacts/regular-waitlist-enhancements-20261002/release-static.log) |
| Real local submission | 57.261 ms in the isolated HTTP sample; acceptance bound 1,000 ms | [Latency JSON](../test-artifacts/regular-waitlist-enhancements-20261002/release/browser/latency.json) |
| Capability / secret / complexity checks | No new dependencies or secret findings. No Dispatch quantity allocation access or existing SO/PO updates. Largest scoped function: 58 lines, budget 80. | [Safety JSON](../test-artifacts/regular-waitlist-enhancements-20261002/release/safety.json) |
| Existing affected workflows | 61 files / 391 tests before and after; same four failing files and 12 failed tests; zero new failing files | [Parent log](../test-artifacts/regular-waitlist-enhancements-20261002/release-baseline-affected.log), [candidate log](../test-artifacts/regular-waitlist-enhancements-20261002/release-affected.log) |
| Suspected fixture replay | Existing four-test fixture passed four fresh replays on each source: 16/16 baseline and 16/16 candidate; test/application hashes identical, assertions unchanged | [Baseline replay](../test-artifacts/regular-waitlist-enhancements-20261002/baseline-full-fixture.log), [candidate replay](../test-artifacts/regular-waitlist-enhancements-20261002/release-fixture.log) |
| Full repository comparison | 786 baseline files vs. 788 final files; the same 63 failing files; zero new failing files | [Baseline log](../test-artifacts/regular-waitlist-enhancements-20261002/baseline-full.log), [final rerun](../test-artifacts/regular-waitlist-enhancements-20261002/final-full.log) |

The baseline reports 4,322 tests: 4,138 passed, 183 failed and one skipped. The completed final run reports 4,333 tests: 4,149 passed, the same 183 failed and one skipped. The repository is not globally green. The existing aggregate browser test exceeded the same external 120-second limit in both runs and remains a failed file, not a passing or skipped check. The [baseline](../test-artifacts/regular-waitlist-enhancements-20261002/baseline-full-timeouts.json) and [final](../test-artifacts/regular-waitlist-enhancements-20261002/final-full-timeouts.json) timeout records are preserved.

The full comparison uses immutable workspace snapshots, excluding unrelated concurrent JavaScript changes. Its nine scoped JavaScript files match the staged candidate. Its SCM HTML includes a separate movement of the existing Special PO stylesheet; the actual staged HTML was independently exercised by all 63 feature tests and the 61-file affected comparison. The staged source, full snapshots and first failed run are retained without overwriting them.

The [first full enhancement run](../test-artifacts/regular-waitlist-enhancements-20261002/final-full-first-attempt.log) reported an additional `23505` unique-date failure in `driver-pwa-historical-assist-concurrency.test.js`: its random historical date collided with an existing fixture date. This occurred before the scenario exercised application behavior. Its test and application sources are identical in baseline and candidate. That original failure is retained; the unchanged fixture was replayed four times on each source, and the full suite was repeated without editing tests or application code. These replays do not establish that the fixture can never collide again.

## Acceptance and failure-model mapping

| Scenarios / failure mode | Executable check |
| --- | --- |
| 19–20: combined filters, numeric/natural sorting, stable ties, clear/refresh, unchanged input and allocation priority | [List properties](mbt/property/regular-waitlist-list.property.test.js), [SCM browser](mbt/integration/regular-waitlist-http-browser.test.js), existing ledger priority tests |
| 21: incorrect stock return, double rejection, lost converted quantity, lost/unread notices, missing reason or stale revision | [Enhancement integration](mbt/integration/regular-waitlist-enhancements.test.js), original conservation/retry properties and mutation checks |
| 22: reject/conversion race or rejection of pending/preparing/submitted/uncertain conversion | [Enhancement integration](mbt/integration/regular-waitlist-enhancements.test.js), existing adversarial and worker-race tests |
| 23: wrong queue order, duplicate PO lines, received/inactive/closed/non-Queued supply, unintended Dispatch allocation access | [Enhancement integration](mbt/integration/regular-waitlist-enhancements.test.js), capability gate and queue-order mutant |
| 24–25: wrong NetSuite date/method field, unwanted address override, invalid date, lost draft, authorization failure, unsafe HTML rendering or phone overflow | [Native payload](mbt/unit/regular-waitlist-netsuite.test.js), [domain validation](mbt/unit/regular-waitlist-domain.test.js), [real HTTP/browser](mbt/integration/regular-waitlist-http-browser.test.js) |
| Original invariants: accounting, source/split capacity, pricing, units, retries, clocks, authorization and separate Dispatch concept | Existing 52 feature scenarios remain covered within the final 63-test runs; original 11 mutants still killed |

The [SCM phone screenshot](../test-artifacts/regular-waitlist-enhancements-20261002/release/browser/scm-filtered-phone.png) shows the actual browser layout. Browser tests exercise the real authenticated app, including filter combinations, header sorting, refresh persistence, Reject/Cancel, Sales rejection display and Delivery conversion. External NetSuite responses are controlled at the network boundary; no live financial transaction was posted.

## Failures and test-contract changes

The [initial RED run](../test-artifacts/regular-waitlist-enhancements-20261002/red.log) and [stronger rejection RED](../test-artifacts/regular-waitlist-enhancements-20261002/red-rejection.log) preceded implementation. Receipt exclusion first failed because a zero receipt baseline masked the live received quantity; the application query was corrected to use their maximum. Browser tests exposed ambiguous filter accessible names; explicit labels fixed the controls. A new customer fixture missing its required legal name was repaired separately, without changing its assertions. The final focused/shuffled runs supersede intermediate GREEN logs.

Three existing Delivery contracts were updated to the user's requested date/method behavior; the browser invalid-input case now checks an invalid date instead of an obsolete time window. These are authorized behavior changes, not assertion weakening. Existing accounting, authorization, legacy workflow and pricing assertions remain in place. No test or application change was made to address the unrelated random-date fixture collision.

## Reproduction and limits

From `server`, using the recorded cached Docker images and sudo Docker access:

```sh
python3 tools/regular-waitlist-enhancements-gauntlet.py
```

This creates fresh timestamped sources, keeps the original full baseline separate, overlays only the recorded 12-file application delta, and uses preserved candidate tests. It runs full baseline/final comparisons, candidate feature/shuffle/property/mutation/static/coverage/safety checks, fixture replays and the 61-file parent/candidate comparison. It uses the dedicated internal `mbbs-waitlist-review` network and disposable databases, disables NetSuite access, and makes no production writes. The individual layers were run for this report; the wrapper is persisted for reproducing them. It does not retry or suppress a failed layer automatically.

To aggregate completed evidence only:

```sh
python3 tools/regular-waitlist-enhancements-gauntlet.py --report-only
```

Versions: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1, v8-to-Istanbul 9.3.0, pg 8.21.0 and PostgreSQL 18. No dependencies, commits or migrations were added for this enhancement. A new migration/rollback rehearsal and dependency audit are inapplicable because neither set changed. There is no scoped formatter gate in this repository. Type checking is differential, branch coverage is below 100%, and the latency measurement is an isolated sample rather than a production percentile guarantee. Stored SCM queue status supplies the recent PO references; this column does not create reservations. Later NetSuite SO edits remain outside waitlist tracking.
