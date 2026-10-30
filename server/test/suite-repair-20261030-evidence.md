# Application test-suite repair evidence

Application verification passed. The operational deployment gate requires the
completed, passing `suite-repair-20261030-full-verification.json`, an identical
source hash, a successful candidate/rollback image rehearsal and a pushed commit.

Spec approval: not obtained (autonomous run). The user authorized fixing the
588 failures and previously authorized commit, push and deployment. The
append-only acceptance criteria and contract amendments are recorded in
`suite-repair-20261030-spec.md`. This was a Tier 3 repair because it touches
posting, authorization and concurrent edits. There was no independent human
review of the amended specification.

## Scope and baseline

The starting deployment was commit
`859dbc987d88fdd41b475f3738cefe9704aae3ea`. Its original test report contained
7,577 tests across 1,253 files: 6,987 passed, 588 failed, one cancelled and one
skipped. Those counts describe automated tests, not individual production
incidents or distinct live bugs. Historical deployment reports remain unchanged.
Intermediate repair runs are condensed in `suite-repair-20261030-history.json`;
repeated stack traces and temporary diagnostic reports were removed under the
host cleanup policy. Dedicated red/green proofs and final evidence are retained.

Many failures came from browser/container setup, missing fixture prerequisites,
or assertions for contracts superseded by existing repository specifications.
The acceptance amendments identify those contracts. No test was newly skipped,
no timing/layout tolerance was increased, and business assertions were retained
unless an explicit contract amendment explains their replacement.

## Final fresh application verification

Source hash: `28e642496e003c1c79126d486481988d6de5faaca02bbc8ad3792c91ba28fb2b`.
All results below come from the final full run after the last application,
test and gauntlet-tool edit, rather than combining earlier passing subsets.

| Layer | Final result |
| --- | --- |
| Complete standard suite, shuffled with seed 20261030 | 1,256 files; 7,630 cases; **7,629 passed, 0 failed, 0 cancelled, 1 existing skip** |
| TypeScript | 339 baseline diagnostics, 339 candidate diagnostics; **0 new** |
| Lint on changed JavaScript | 722 baseline diagnostics, 703 candidate diagnostics; **0 new** |
| Changed executable application JavaScript line coverage | **60/60**, across the 11 changed functional files in `src/` and `public/` |
| Manual mutation checks | **5/5 faults detected**, with every temporary mutation restored and hash-checked |
| Property-only mutation check | Consolidation fault detected by its property alone; counterexample recorded |
| Adversarial/property behavior | Guard rejects hostile connection inputs and runs 200 generated database-name cases; consolidation runs 150 generated order/gate mixes; existing authorization, revision, atomicity, retry and stale-acknowledgement cases pass |
| Real execution | Real HTTP server/SQL and Chromium workflows run in the full suite, including the repaired startup check |
| Test cleanup | Exit 0; **0 containers, 0 volumes, 0 networks left**; production health passes |

The sole full-suite skip remains in
`integration/mbbs-cross-charge-route-pricing-v4-migration.test.js`. The mutation
property-only invocation deliberately selects one property and excludes its five
nonmatching examples; those exclusions do not change the full-suite skip count.
The complete machine-readable result is `suite-repair-20261030-full-verification.json`.

## Image and rollback rehearsal

Candidate image:
`sha256:84764179b5e9d7769b64b1f195be82fd4170f6d7ef3202fc4bdc3f041e4836ff`.
The actual candidate app and worker start successfully against an isolated
database, return health 200, reject anonymous API access with 401, and match all
1,627 prepared runtime-file hashes per service. The actual prior app and worker
images also start successfully against that schema, with health 200 and anonymous
API status 401. There are no pending migrations. Rehearsal containers, volumes,
networks and raw output are removed; production health passes afterward.
See `suite-repair-20261030-image-smoke.json`.

The private operational release record is under
`server/deployments/suite-repair-20261030/`. Cutover verifies the pushed commit,
source/image identity, preserved runtime configuration and inactive business
operations, and restores the prior images if readiness or verification fails.
It checks the served repair assets as well as the image contents. Production
data and rollback records are outside disposable-test cleanup.

## Application repairs and regression evidence

Paths below are relative to `server/test/mbt/`.

| Behavior | Regression evidence |
| --- | --- |
| Completed Special requests reject line/header writes before SQL triggers; editable requests retain transactional/revision protection | `integration/special-case-edits-http.test.js`, `integration/special-header-note-http.test.js` |
| Grouped saved orders avoid the numeric-only reopen lookup while retaining yard authorization | `integration/operator-yard-access.test.js` (36-case authorization matrix) |
| Operator service-worker cache contains the exact HTML asset URLs and preserves Driver caches | `unit/operator-yard-assets.test.js`, `unit/receiving-multi-yard-ui.test.js` |
| Menu-order catalog matches the existing navigation, including Repair, Order Reopen, Stock Check and MBR Setup | `unit/menu-order.test.js`, `integration/menu-order-http.test.js` |
| Login can use an authorized secondary MBT role when the primary has no route; unauthorized return URLs remain rejected | `unit/ui-navigation-contract.test.js` |
| Waitlist tab navigation preserves focus; acknowledgement removes the matching return notice without losing allocation drafts | `integration/regular-waitlist-http-browser.test.js`, `integration/scm-waitlist-return-race-browser.test.js` |
| Failed acknowledgements retain the notice and an older acknowledgement cannot clear a newer return event | `integration/scm-waitlist-return-race-browser.test.js` |
| Manual Special SO linking remains available before stock decisions are complete, with lifecycle/draft/order guards | `unit/special-manual-so-ui.browser.test.js`, `integration/special-po-reference-only-browser.test.js` |
| Revoking a decline recomputes the current stock-check stage; price-only edits retain valid metadata | `integration/special-line-decline-http.test.js`, `integration/special-case-edits-http.test.js` |
| Ambiguous NetSuite write responses do not trigger automatic duplicate submissions; reads and explicit concurrency rejections retain bounded retries | `integration/netsuite-write-retry-safety.test.js`, `integration/special-workflow-description-race.test.js` |
| A stock-check event produces one Sales popup while separate business actions remain outstanding | `integration/sales-stock-check-popup.test.js`, Backorder browser suites |
| Waiting labels align on wide cards and wrap on phones without relaxed tolerances | `integration/request-waiting-labels-browser.test.js` |
| Consolidated Sales Order loading stays local and creates durable background work without synchronous NetSuite reads | `integration/consolidation-load.test.js`, `unit/consolidation-load-posting.test.js` |

Changed browser assets receive new URLs; the Operator cache generation is
advanced. The migration-readiness inventory now includes all 326 existing
migrations. No database migration or dependency was added by this repair.

## Test infrastructure and invariants

The shared disposable-connection guard accepts only the isolated `db` service,
the synthetic test account and the allowed base/per-file database names. Its
negative cases reject live/loopback hosts, unexpected accounts/ports, connection
overrides, invalid clone names and missing isolation flags. Two seeded properties
exercise 100 rejected names and 100 valid clone identities.

The first shuffled full run found an additional output-directory dependency in
`tools/regular-waitlist-startup.mjs`. The application health and expired-allocation
assertions completed before writing the report failed with ENOENT. The tool now
creates its own disposable output directory. A clean targeted replay passes.
See `suite-repair-20261030-shuffled-output-directory-red.json` and
`suite-repair-20261030-shuffle-tooling-check.json` for the red/green evidence.

The login VM retains its original source filename and offsets so V8 attributes
the already-executed fallback to its actual line. The property-only mutation
invocation explicitly selects Node's spec reporter and records the concrete
counterexample instead of relying on the default TAP error formatting.

Every run freezes source, uses the standard isolated Compose setup and per-file
database clones, and stays inside `mbbs-tests.slice` (4 GiB, two CPUs). The two
test containers have 1.5 GiB limits; the database has a 1 GiB limit. Init, PID,
read-only-root and tmpfs bounds remain enforced. Teardown is registered before
containers start, removes containers/volumes/networks, checks both `docker ps`
and `docker ps -a`, and checks production health. The outer retention runner
removes raw logs, coverage, screenshots, databases and temporary source copies.

## Reproduction

From the repository root, using the installed bounded test environment:

```sh
sudo -n python3 docker/retention/retention.py run -- \
  python3 server/tools/suite-repair-20261030.py \
  --label full-verification --full --shuffle 20261030 --static --coverage --mutations
```

The runner pins comparisons to the original deployed commit, so committing the
repairs does not erase the changed-line or static-baseline comparison. The JSON
report identifies the tested source hash. Dependencies are fixed by the existing
lockfile. The actual test image is
`sha256:9647b0f906821d14384c68ee8c8cf5a5f5e7d1ec20b863de6f181dc1fb5b8b37`,
with Node 20.20.2; recorded lockfile versions are Playwright 1.62.1,
fast-check 4.9.0, TypeScript 7.0.2, ESLint 10.8.0 and v8-to-istanbul 9.3.0.
Mutation edits affect only the disposable snapshot and are restored
with a source-hash check after each fault.

The five manual faults remove: the ambiguous-write retry guard, the returned-
event identity guard, the background-SO consolidation exclusion, the completed-
case edit guard and the secondary-role login fallback. Consolidation is also
checked against its property alone: 150 seeded generated mixes of SO/TO/CO
orders, with both gate states and an exact expected target list. The deliberate
fault shrinks to one Sales Order with the gate enabled, incorrectly materializing
`['1']` where `[]` is required.

The staged credential check reuses `tools/worktree-commit-check-20261030.py`
with this release's report and explicit review list. It compares staged content
with live credential values without printing them, scans provider-token/private-
key patterns and reviews credential-like literals. One newly flagged fixture
variable named `secret` contains a Sales-only document-exclusion remark, not a
credential; its exact line hash and review are recorded. Final results are in
`suite-repair-20261030-secret-check.json`. The dependency manifests are unchanged,
so a new-dependency supply-chain audit does not apply. Application code adds no
external service or new filesystem/subprocess capability; the return-read HTTP
call uses the existing application endpoint and the retry repair restricts
automatic NetSuite write resubmission.

## Limits

The standard `test:mbt` selection includes infrastructure, unit, contract,
property, integration, adversarial and concurrency files, including real HTTP
and Chromium tests. It is distinct from the separate Playwright `test:mbt:e2e`
command. Live NetSuite writes are not used for validation. CSS and cache-version
URL changes are checked by DOM/exact-asset assertions rather than JavaScript
line coverage. Test helpers and operational tools are outside the application
line-coverage metric; the migration inventory has exact readiness assertions.
Changed-line coverage is an execution measure, not proof of
every business requirement; mutation and adversarial assertions supplement it.

Existing TypeScript/lint debt at the starting commit is compared explicitly;
the repair requires zero new diagnostics. NetSuite script uploads remain the
user's manual process, as documented in `docs/netsuite-deployment-status-20261030.md`.
