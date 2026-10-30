# BIN planning corrections and garbage deposits — 2026-10-23

Spec: [criteria 42–50](bin-order-workflow-spec.md). Tier 3 (money, command authority,
shared planning). Spec approval: not obtained (autonomous run); the user explicitly
requested implementation and confirmed CAD500 per bin. No dependencies, installs
or commits. Existing dirty workspace changes are preserved through a three-way
overlay onto the captured live image.

## Behavior evidence

| Requirement | Executable evidence |
| --- | --- |
| Optional Front Desk delivery reason; planned work stays protected | `integration/bin-planning-corrections.test.js`, `bin-collection-request-browser.test.js`, `bin-order-window.test.js` |
| Consecutive Front Desk changes use refreshed revisions even with delayed responses | `bin-collection-request-browser.test.js` holds the real timeline HTTP response and checks that each dialog remains open with submission disabled |
| Dispatch cannot change requested windows through direct or nested commands | `bin-order-window.test.js`, `bin-planning-corrections.test.js`, `bin-order-workflow.test.js`, workflow browser |
| Toolbar-only actions, Change bin, drag/drop, cards fit 1600/1024/768 widths with long text | `bin-order-workflow-browser.test.js`, `bin-selection-browser.test.js`, `bin-planning-browser.test.js` |
| Planned/completed cross-date search and load navigation; withdrawn/missing loads never appear current | `bin-planning-corrections.test.js`, `bin-planning-search-browser.test.js` |
| Legacy blocked tentative collections stay hidden; available work returns after unplanning | `bin-planning-commands.test.js`, `bin-planning-http.test.js`, `bin-planning-driver.test.js`, shared planning browser |
| Incoming item's deposit wins; ambiguous rules reject; signed prices and credits survive | `bin-garbage-deposit.test.js`, `property/bin-collection-request.property.test.js` |
| CAD500 versions for both sizes preserve components, roll back and replay safely | `bin-garbage-deposit.test.js` executes `tools/bin-garbage-deposit-rates.mjs` against disposable PostgreSQL |
| Existing component-bound BIN rate cards work without changing their binding | The same deposit setup test runs once with item-bound cards and once with the live legacy layout |
| Fixed fill rates, deferred garbage dumping, explicit collection, driver evidence and ordinary Dispatch survive | Full affected BIN, Front Desk, rate-card and billing suites, including concurrency/adversarial files and shared planning browser |

## Reproduction

From the repository root, after preparing the captured live overlay:

```sh
sudo -n env DISPATCH_SOURCE_SKIP_BUILD=1 \
  DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/bin-planning-corrections-20261023/candidate" \
  DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/bin-planning-corrections-20261023/candidate/migrations" \
  MBBS_BIN_SELECTION_EVIDENCE_PATH="$PWD/server/deployments/bin-planning-corrections-20261023/validation.json" \
  bash docker/run-bin-planning-corrections-checks.sh
```

The runner uses bounded containers in `mbbs-tests.slice`, disposable databases per
test file, a unique artifact directory, and registered teardown before startup.
It checks both Docker container listings, removes volumes/networks and generated
logs/coverage/screenshots, and verifies production health.

## Validation

Final fresh run completed at `2026-10-23T05:27:49.409Z` with no source drift.

| Layer | Result |
| --- | --- |
| Full affected suite | 513 tests in 118 files; 512 passed, one independently reproduced baseline failure, zero new failures |
| Reverse-order focused suite | 125/125 passed in 21 files |
| Syntax, types, lint, secret scan | 10 runtime JS files; zero new type/lint errors and zero secret findings |
| Changed runtime lines | 146/146 covered; no unmeasured JS files |
| Changed branches | 108/121 covered; partial branch coverage remains a limit |
| Manual mutation checks | 7/7 killed, including two money mutants against property tests alone |
| Real execution | Authenticated real-server Chromium flows and disposable PostgreSQL command/rollback checks passed |
| Host cleanup | Runner teardown passed and production health remained healthy |

Toolchain: node v20.20.2, typescript 7.0.2, eslint 10.8.0, c8 12.0.0, fast-check 4.9.0, playwright 1.62.1, pg 8.21.0.
Runtime manifest SHA-256: `ee157749c8bab0026b2c5ef9f284b701c1403f31ca6b8d14ec1b2527dedc5497`.
Image: `sha256:7aa5060b406429b9a02831c254aa595fa806b250bde50ea71bc10d4fbc843dab`.
Per-file runtime and operational-script hashes are retained in
`deployments/bin-planning-corrections-20261023/validation.json`.


## Findings and limits

The initial regression run exposed legacy tentative collections in search and a
cached assignment hiding an order after unplanning. Both were corrected without
weakening the existing eligibility assertions. Older tests that intentionally
excluded planned/completed search results were updated under criterion 48;
availability checks still require only ready unassigned work. Front Desk optional
reason, window authority, deposit selection/ambiguity and browser controls were
observed failing before their fixes. Tests also found and corrected search
navigation saving in View mode and a competing feed-refresh race.

The second full run had zero new main-suite failures, but its reverse-order pass
exposed a real Front Desk race: the time dialog closed before the updated line
revision arrived. A deterministic browser test held that HTTP response and failed
with the dialog already hidden. The fix closes the time/charge dialogs after
refresh and disables resubmission while awaiting it. The delayed-response test
then passed; the final gauntlet was rerun after that source change.

A read-only production preflight found that the live BIN rate cards bind their
items through rental components, with a null card-level item. One in-progress
validation run was stopped and fully torn down before adapting the correction.
The legacy-layout fixture reproduced the rejection, then passed after resolving
the unique BIN item from the preserved components. The final run hashes both the
rate-update module and its Python activation wrapper; activation verifies those
hashes against the passing report.

All behavioral and reverse-order checks then passed, but Chromium's final coverage
snapshot omitted the already-asserted price confirmations before a page reload.
The browser recorder now checkpoints coverage before that reload, following the
existing workflow-browser pattern. Assertions and runtime code were unchanged;
the final gauntlet was rerun with that measurement correction.

One baseline source-pattern test is already failing on the captured live source:
`the production MBT router is wired to the server-owned pricing adapter` in
`unit/frontdesk-pricing-adapter.test.js`. It assumes `frontdeskPricing` is the first
router option. The runner independently reproduces that failure against unchanged
baseline source and allows only that exact failure; no unrelated test was skipped.

The gauntlet covers the affected suites, not every application subsystem. New
helpers are small; the shared Dispatch change is one conditional. No dependency
audit or installation is needed because dependency manifests are unchanged. The
existing lint rules supply style checks; no separate formatter is configured for
this change. Property tests cover signed price/deposit reversal, overdue boundaries
and exact garbage-weight rounding (400 generated examples per property). Two money
mutants run against the property suite alone. Browser geometry checks cover CSS;
JavaScript line coverage does not measure HTML/CSS. No live test orders, payment
transactions or customer notifications are created.

The changed-line coverage gate measures the 13-file runtime manifest. Operational
wrappers have integration, rollback/replay and read-only preflight checks plus
recorded source hashes; they are outside that runtime line-coverage percentage.

## Release and operations

Release tooling: `tools/bin-planning-corrections-release.py` prepares/builds/deploys
the 13-file overlay and verifies deployed hashes, HTTP routes and unchanged service
configuration. It retains the prior image and rolls back its own deployment if
verification fails. No database migration is required.

`tools/bin-garbage-deposit-configure.py configure` applies the user-authorized
deposit through versioned configuration commands, preserving before/after graphs
and an idempotent operational audit. `tools/bin-planning-corrections-live-read.py`
checks BIN00002D on two plan dates inside a read-only transaction. The release
directory retains concise validation and operational records; test artifacts are
disposable.


Completed deployment at `2026-10-23T05:28:24Z`. Live hashes matched all 13
validated runtime files; application health and protected HTTP routes passed.
Application configuration and the other three production services were preserved.

Both active BIN item rate cards now have exactly one CAD500 fixed garbage deposit.
The old versions remain in history. The live comparison verified that 14YD rental
remains CAD0, 20YD rental remains CAD300, and both extension rates remain CAD20/day.
Soil/Concrete/Asphalt remain CAD300/bin; DumpGarbage remains CAD120/tonne.

The deployed read-only search returned BIN00002D exactly once from both
2026-10-23 and 2030-01-02 views, with its actual 2026-10-21 plan and load.
No operational orders, assignments, payments or customer notifications were created
by verification. Both Docker listings contain only the four production containers;
owned test containers, volumes, networks and final generated artifacts are gone.

Operational records: `deployment.json`, `live-verification.json`,
`deposit-configuration-audit.json`, `deposit-verification.json`,
`live-search-verification.json` and `cleanup-verification.json` in
`deployments/bin-planning-corrections-20261023/`.
