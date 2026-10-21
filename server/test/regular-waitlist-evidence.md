# Regular Waitlist implementation and release evidence

The approved [acceptance specification](regular-waitlist-spec.md) is implemented. Sales can submit a one-item Waitlist under **Type** with an existing customer, quantity and selling yard. SCM uses its own Waitlist workspace to reserve incoming PO or split-PO capacity, confirm allocations, and reallocate returned quantities. This ledger is independent of Dispatch's PO-to-SO quantity allocations.

Sales converts all current held quantity to a new native-priced Sales Order, choosing Pickup or Delivery. A partial conversion retains the original request ID and queue time for the remainder, or closes it at Sales' choice. Closing a request returns unused holds immediately. Converted quantity stays consumed; subsequent NetSuite SO edits, cancellation and fulfillment are not synchronized back into the waitlist.

SCM can release a full unused hold after 30 minutes with a reason. Automatic release starts after three hours only when another open request for the same item needs unallocated stock. An independent 15-second local check and startup catch-up implement this rule. Returned stock stays in its PO/item pool and requires SCM confirmation for reallocation. Sales event notices and SCM returned-pool notices persist until acknowledged.

## Recorded result

The machine-readable gate is [checks.json](../test-artifacts/regular-waitlist/checks.json). Its scoped source digest is `491b2847dd28b42c7b2cab9ad526f0782f2372b843df8a8d0555a5557067064b`.

| Verification | Final result | Evidence |
| --- | --- | --- |
| Waitlist tests, actual staged release | 52 passed across nine files; zero failed, cancelled or skipped | [Focused run](../test-artifacts/regular-waitlist/release-focused-complete.log) |
| Deterministic shuffled order | Same 52 passed, seed 261002 | [Shuffled run](../test-artifacts/regular-waitlist/release-shuffled-complete.log) |
| Properties | Four properties, 400 examples each, seed 261002 | [Property tests](mbt/property/regular-waitlist.property.test.js) |
| Real HTTP submission | 61.254 ms, below the 1,000 ms acceptance bound | [Latency sample](../test-artifacts/regular-waitlist/release/browser/latency.json) |
| Changed executable JS lines | 915 of 915 covered; no uncovered changed lines | [Coverage](../test-artifacts/regular-waitlist/release/changed-lines.json) |
| Scoped branch coverage | 639 of 749 branches covered | [Coverage](../test-artifacts/regular-waitlist/release/changed-lines.json) |
| Manual mutation checks | 11 of 11 killed by normal assertion failures; four domain mutants also killed by property tests alone | [Mutation results](../test-artifacts/regular-waitlist/release/mutations.json) |
| Syntax / lint / types | 19 scoped JS files parsed; zero new lint findings; zero new type diagnostics (797 baseline, 796 current) | [Static run](../test-artifacts/regular-waitlist/release-static-complete.log) |
| Dependency / secret / capability checks | No new dependencies or secret findings; no Dispatch allocation access, existing SO updates or PO updates | [Safety gate](../test-artifacts/regular-waitlist/release/safety.json) |
| Migration rehearsal | Interrupted transaction rolled back; previous constraints restored; successful commit created seven ledger tables in a disposable database | [Migration result](../test-artifacts/regular-waitlist/migration.json) |
| Full repository comparison | 777 baseline files vs. 786 final files; 64 baseline failing files vs. 63 final; zero new failing files | [Baseline](../test-artifacts/regular-waitlist/baseline-full-fresh.log), [final](../test-artifacts/regular-waitlist/final-full-complete.log) |
| Affected workflows on the actual release | 61 files / 391 reported tests; same four failing files and 12 failed tests before and after; zero new failing files | [Release baseline](../test-artifacts/regular-waitlist/release-baseline-affected.log), [release final](../test-artifacts/regular-waitlist/release-affected-complete.log) |

The full suite is not globally green: its unrelated pre-existing failures remain. The final run reported 4,322 tests: 4,138 passed, 183 failed and one skipped. The existing `aggregate-request-browser.test.js` exceeded the same external 120-second limit in both baseline and final, and is recorded as a failed file, not a passing or skipped check. See the [baseline timeout](../test-artifacts/regular-waitlist/baseline-full-timeouts.json) and [final timeout](../test-artifacts/regular-waitlist/final-complete-timeouts.json). The earlier `final-full.log` run was invalidated by a source-directory replacement and is not evidence for this release. The gate uses only the completed final run linked above.

The full comparison used preserved workspace snapshots. The deployment was independently rebased onto the captured live app, preserving changes outside the approved 23-file delta. Its nine feature files and 61 affected regression files were run against that actual staged candidate. The changed JS is identical; the SCM HTML preserves a previously deployed asset version. The [manifest](../deployments/regular-waitlist-20261002/manifest.json), [patch](../deployments/regular-waitlist-20261002/changes.patch) and source hashes bind the validation to the release.

## Acceptance-to-test mapping

| Specification scenarios | Executable evidence |
| --- | --- |
| 1–2: local one-item/customer/quantity/unit/yard validation; immutable request | [Repository](mbt/integration/regular-waitlist-repository.test.js), [HTTP/browser](mbt/integration/regular-waitlist-http-browser.test.js), [adversarial](mbt/adversarial/regular-waitlist-adversarial.test.js) |
| 3–4: shared PO/split capacity, receipts independent, amended/cancelled PO guards | [Safety](mbt/integration/regular-waitlist-safety.test.js), [nested splits and changed units](mbt/adversarial/regular-waitlist-adversarial.test.js), [native unit boundary](mbt/unit/regular-waitlist-netsuite.test.js) |
| 5: UNI/BWS → 3445; PER/TH → 2967; FIFO; audited override | [Domain](mbt/unit/regular-waitlist-domain.test.js), [properties](mbt/property/regular-waitlist.property.test.js), [repository priority](mbt/integration/regular-waitlist-safety.test.js) |
| 6–7: partial conversion/remainder/close; only unused stock returns | [Repository](mbt/integration/regular-waitlist-repository.test.js), [Sales browser flows](mbt/integration/regular-waitlist-http-browser.test.js), [conservation properties](mbt/property/regular-waitlist.property.test.js) |
| 8–11: 30-minute manual release; three-hour competing-demand release; late demand; same-pool manual reallocation | [Domain](mbt/unit/regular-waitlist-domain.test.js), [repository](mbt/integration/regular-waitlist-repository.test.js), [real startup](mbt/integration/regular-waitlist-startup.test.js), [independent timer](mbt/integration/regular-waitlist-safety.test.js), [SCM phone browser](mbt/integration/regular-waitlist-http-browser.test.js) |
| 12: all held quantity, Pickup/Delivery, native pricing and selling-yard units | [NetSuite payload contracts](mbt/unit/regular-waitlist-netsuite.test.js), [Sales browser conversion](mbt/integration/regular-waitlist-http-browser.test.js) |
| 13: serialized changes, stale revisions, idempotency, worker leases | [Real PostgreSQL race](mbt/integration/regular-waitlist-repository.test.js), [adversarial races and retries](mbt/adversarial/regular-waitlist-adversarial.test.js) |
| 14–16: persisted marker, uncertain-response recovery without reposting, preparation failures, immutable creation refs/no SO synchronization | [Safety](mbt/integration/regular-waitlist-safety.test.js), [NetSuite boundary](mbt/unit/regular-waitlist-netsuite.test.js), [worker race](mbt/adversarial/regular-waitlist-adversarial.test.js), [capability scan](../test-artifacts/regular-waitlist/release/safety.json) |
| 17: deduplicated Sales notices and per-SCM returned-pool acknowledgements | [Safety notices](mbt/integration/regular-waitlist-safety.test.js), [adversarial acknowledgements](mbt/adversarial/regular-waitlist-adversarial.test.js), [SCM browser deep-link](mbt/integration/regular-waitlist-http-browser.test.js) |
| 18: legacy workflow exclusion and Sales/SCM authorization | [Legacy guards](mbt/integration/regular-waitlist-legacy-guards.test.js), [HTTP authorization](mbt/integration/regular-waitlist-http-browser.test.js), affected-suite comparison above |

The browser tests run authenticated HTTP and real Chromium on desktop and phone layouts, including keyboard tab navigation, inline failure display/draft retention, allocation, close, release and acknowledgement. SO completion is controlled at the external network boundary; no real financial transactions are posted by these tests.

The over-allocation test uses an independent PostgreSQL transaction to lock both request rows, starts competing allocations and waits for both database waiters before releasing the barrier. This made the ledger-lock mutant fail deterministically without weakening any test assertion. Throwaway mutant copies are restored and source hashes verified; production source is never mutated.

## RED → GREEN evidence

Initial failing assertions were recorded before the corresponding implementation or corrections. Representative pairs:

| Behavior | RED | GREEN |
| --- | --- | --- |
| Quantity, pool conservation, priorities and release clocks | [Domain RED](../test-artifacts/regular-waitlist/red-domain.log) | [Domain GREEN](../test-artifacts/regular-waitlist/green-domain.log) |
| Ordinary native-priced Sales Order payload | [Native RED](../test-artifacts/regular-waitlist/red-netsuite-native.log) | [NetSuite GREEN](../test-artifacts/regular-waitlist/green-netsuite.log) |
| Persistent local reservations and atomic changes | [Repository RED](../test-artifacts/regular-waitlist/red-repository.log) | [Repository GREEN](../test-artifacts/regular-waitlist/green-repository.log) |
| Strict parsers, conversion races, idempotency and acknowledgements | [Adversarial RED](../test-artifacts/regular-waitlist/adversarial-red-fixed-fixture.log) | [Adversarial GREEN](../test-artifacts/regular-waitlist/adversarial-green.log) |
| Nested split source capacity | [Nested RED](../test-artifacts/regular-waitlist/nested-red.log) | [Nested GREEN](../test-artifacts/regular-waitlist/nested-green.log) |
| Independent expiry while remote conversion is slow | [Timing RED](../test-artifacts/regular-waitlist/timing-red.log) | [Timing GREEN](../test-artifacts/regular-waitlist/timing-green.log) |
| Phone layout and usable allocation controls | [Phone diagnostic](../test-artifacts/regular-waitlist/phone-diagnostic-2.log) | [Phone GREEN](../test-artifacts/regular-waitlist/phone-green.log) |

The final 52-test focused/shuffled runs supersede intermediate GREEN runs. Existing cache-version assertions stayed unchanged; the application asset URLs were corrected to retain their established query structure.

## Reproduction

From `server`, with the recorded cached Docker images and sudo Docker access:

```sh
python3 tools/regular-waitlist-gauntlet.py
```

This creates a fresh timestamped source directory and evidence directory, runs the isolated baseline/final full suites, focused/shuffled tests, properties, mutations, static/coverage/capability checks, and transactional migration rehearsal. It disables NetSuite access and performs no production writes. It requires the preserved baseline at `test-artifacts/regular-waitlist/frozen-baseline` and scoped candidate at `deployments/regular-waitlist-20261002/candidate`. The individual commands were executed for this release; the wrapper assembles them for reproduction.

To aggregate the already completed release logs without rerunning tests:

```sh
python3 tools/regular-waitlist-gauntlet.py --report-only
```

Versions: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1, v8-to-Istanbul 9.3.0 and pg 8.21.0. Tests use PostgreSQL 18 in the dedicated `mbbs-waitlist-review` network. No project dependencies were added.

## Limits and operational behavior

- The 61 ms submission result is an isolated HTTP sample, not a production percentile or sustained-load guarantee.
- No production NetSuite Sales Order was created for smoke testing. Native pricing, unit representation, marker recovery and retry behavior were verified through payload contracts and controlled network responses.
- After a remote create is started, an uncertain response keeps the quantity claimed and allows marker lookup only. A definitive rejection without a marker also remains conservative and may need support reconciliation; there is no manual recovery UI. This avoids blind duplicate financial writes.
- Coverage is complete for changed executable lines, not every branch. Type checking is a differential JavaScript check; the large server boundary is verified with syntax, authenticated HTTP and real startup.
- The repository has no scoped formatter gate. No dependency audit was introduced because this release adds no dependencies. Existing full-suite failures and the existing browser timeout are disclosed above.
- Malformed split lineage or unknown unit mappings fail closed. Converted quantities never return automatically after later SO changes.

## Deployment

The release script [regular-waitlist-deploy.py](../tools/regular-waitlist-deploy.py) builds an offline overlay of the approved 23-file delta over the captured live image. It verifies complete source hashes, preserves configuration and other services, checks for active financial operations, applies `254_regular_waitlist.sql` transactionally, and switches only the app. A failure restores the prior app image while retaining the additive schema.

The authoritative live verification is [result.json](../deployments/regular-waitlist-20261002/result.json). The release image is `mbbs-operator-app:regular-waitlist-20261002`, image ID `sha256:d8ee3058ca1cb3874ddf271d2e7c78efbc5e92a951f958537532a962abd23df7`. Local/public health, exact public asset bytes, protected waitlist routes, migration presence, preserved configuration and unchanged worker/database/other services passed. Verification created zero production Sales Orders.

## Later enhancement review

The separately requested SCM filtering/sorting/rejection/queued-PO references and date-only Delivery conversion are documented in [the enhancement evidence](regular-waitlist-enhancements-evidence.md). Their deployment is held at the user's instruction. The results above describe the earlier release and do not claim that the later enhancements are live.
