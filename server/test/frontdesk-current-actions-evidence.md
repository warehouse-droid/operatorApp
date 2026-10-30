# Front Desk current-action rates and responsive selection

Spec: [frontdesk-current-actions-spec.md](frontdesk-current-actions-spec.md).
Tier 3 (money and concurrency). Spec approval: not obtained (autonomous run).
The user explicitly authorized current rates for new bin, exchange and collection
actions, preservation of unfinished work, and improved Front Desk responsiveness.

## Behavioral evidence

- `frontdesk-current-actions.test.js`: retired contract resolves the active
  version of the same card; new add-bin, exchange and bin change use it;
  confirmation retains previewed prices after another activation; historical
  contract pricing stays unchanged. Reject missing contracts, unrelated/unknown
  versions, inactive cards and missing active versions. Collection captures the
  current tariff and rescheduling keeps its saved price. Compact summaries
  preserve contract identity/counts and the full API remains available.
- `frontdesk-collection-rate.test.js`: actual driver pickup, dump receipt and
  return lifecycle retains $120/tonne after $200/tonne activates; 2.25 tonnes
  remains $270. Legacy completion uses request-date rates. Missing or conflicting
  saved tariffs produce review results without fabricated charges.
- `frontdesk-current-actions-browser.test.js`: actual authenticated app and
  PostgreSQL verify fresh add-bin configuration across activation on an open
  page, plus refreshed rate choices for a new quote.
- `frontdesk-selection-browser.test.js`: real HTML/JavaScript with delayed HTTP
  boundaries verifies immediate loading/selection, stale-response protection,
  duplicate-click suppression, one timeline request, failed-load retry and
  explicit missing-rate feedback. Repeats with and without transport cancellation.
- `frontdesk-current-actions-race.test.js`: an action waits for in-flight
  activation and then uses the committed current version.
- `frontdesk-current-actions.property.test.js`: generated deposit values and
  measured weights verify exact current pricing, foreign-card rejection,
  immutable exchange evidence, and saved tariff × measured weight. Four deliberate
  financial bugs are tested against the regressions and against properties alone.
- Existing Front Desk, charge calculation, BIN workflow, collection, fixed dump,
  garbage deposit, adversarial, HTTP and concurrency suites protect prior behavior.

## Reproduction and release scope

From the repository root, run `bash docker/run-frontdesk-current-actions-checks.sh`
after `python3 server/tools/frontdesk-current-actions-release.py prepare` has
captured the live baseline and prepared the scoped candidate. The runner uses
the repository's existing disposable image, `mbbs-tests.slice`, bounded Compose
resources, a fresh disposable database per test file, and automatic teardown.
It performs static/type/lint/complexity and diff-secret checks, the regression
suite, backend and browser changed-line coverage, reversed focused suites, and
four persisted mutants. Tool versions, exact source hashes and final counts are
recorded in `deployments/frontdesk-current-actions-20261026/validation.json`.

Only the eight files in `tools/frontdesk-current-actions-files.json` are merged
over captured live sources. No dependencies, schema migrations, commits or
production test orders are introduced. Dependency/license audit is inapplicable
because dependencies are unchanged. The deploy command requires a passing report
for the exact source hashes and unchanged live-service metadata; it retains a
rollback image, preserves application configuration and checks health and hashes.

## Failures resolved during development

Initial regressions reproduced inactive historical-rate rejection, missing
collection pricing evidence, a $200 completion rate replacing the requested $120
rate, and absent browser loading feedback. Later browser checks caught stale
new-quote workflow choices and a stale error message after successful retry.
The fixes address those behaviors without weakening their assertions.
Test fixture setup was corrected to obey used-version retirement/revision rules,
copy complete rate definitions and set pricing before completed-visit immutability.
Static checks required smaller configuration/pricing helpers and a typed returned
snapshot rather than adding an undeclared property.

## Final validation

Fresh run completed 2026-10-26T21:14:20.684Z against source manifest SHA-256
`4e45507c8ce4baccad06534e1c8af243a9e4ea54dd7908a8966bae4d18c5e388`.

- Affected regression suites: **193/193 passed**, 40 files, no skips or source drift.
- Reversed focused suites: **14/14 passed**, 6 files.
- Changed executable lines: **259/259 covered**; changed branches: **116/123**.
- Four financial mutants: **4/4 killed by regressions plus properties** and
  **4/4 killed by the property suite alone**.
- Static: 7 JavaScript files; **0 new lint/type errors**, baseline scoped type
  errors 0; syntax, complexity and diff-secret checks passed.
- Toolchain: node v20.20.2, typescript 7.0.2, eslint 10.8.0, c8 12.0.0, fast-check 4.9.0, playwright 1.62.1, pg 8.21.0.
- Disposable test containers, database storage, networks and raw run artifacts
  were removed. Both Docker process listings showed only production containers
  after the final run; application health passed.

This verifies the specified cases; it is not proof for every possible pricing
configuration. Seven changed branches remain uncovered. Incomplete/ambiguous
garbage tariffs deliberately require billing review rather than guessed pricing.


## Live verification

Deployed 2026-10-26T21:14:46Z as `mbbs-operator-app:frontdesk-current-actions-20261026`
(`sha256:425eeb757543e384a1338f6d4ca5404cbfa05d092f6bdd8b3ad4c24808aad8dd`). All eight deployed file hashes matched
the tested candidate. Application configuration and the other three production
services were preserved; health and route/authentication checks passed.

A read-only transaction verified contract `MBT-C-96ED89AC9B9B`
resolves its historical version 2 to active version 3 for new action configuration.
Its historical pricing hash remains `7d8683a9884397b9b6e5bc267bd1aa9662c7c9e138108add3f87bd9df0cf683a`.
The two-contract customer response shrank from **12,765 to 437 bytes**;
this is a payload measurement, not an end-user latency benchmark. The timeline
contains charge history, so the browser needs one detail request. No production
orders, collections, exchanges or price previews were created during verification.

After deployment, `docker ps` and `docker ps -a` showed only the four production
containers. Network and volume listings contained only Docker defaults and
production/rollback resources. `/tmp/frontdesk-current-actions-tests` was empty.
