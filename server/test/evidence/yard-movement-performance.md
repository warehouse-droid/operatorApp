# In/Outbound performance evidence — 2026-10-22

Scope: Control, Sales and Dispatch In/Outbound Record. The runtime change is
limited to seven files: the shared movement repository, two page clients, three
HTML script references, and the new pending-read helper. No dependency or schema
change. Spec approval: not obtained (autonomous run). Tier 3 was used for scoped
history reads and concurrent browser responses.

The executable contract is `../yard-movement-performance-spec.md`. The release
audit is `../../deployments/yard-movement-performance-20261022/`.

## Reproduce

From the repository root, run:

```sh
bash server/tools/yard-movement-performance-isolated.sh
```

The runner installs the existing locked tools, uses the standard bounded Compose
configuration under `mbbs-tests.slice`, registers teardown before setup, and
removes containers, volumes, networks, logs, browser downloads and temporary
coverage/type-check files. It checks both running and stopped containers and the
production health endpoint after teardown.

The release was assembled from the live image, with only this task's patch
applied. Exact-image validation uses:

```sh
YARD_PERF_RUNTIME_IMAGE=mbbs-operator-app:yard-movement-performance-20261022 \
YARD_PERF_RELEASE_DIR="$PWD/server/deployments/yard-movement-performance-20261022" \
bash server/tools/yard-movement-performance-isolated.sh \
node tools/yard-movement-performance-candidate.mjs
```

The manifest identifies the complete runtime tree and input hashes. Validation
compares every runtime file against that manifest before running the gauntlet.
Tool versions and final timing samples are retained in `validation-passed.json`.

## Contract mapping

| Contract | Executed checks |
| --- | --- |
| P1: retain records, aliases, quantities, documents, photos and CSV identity | Existing PO search/document-history regressions; movement and reload-history harnesses; generated case/whitespace/collision properties |
| P2: bound selected-reference matching and use existing PO indexes | Real PostgreSQL EXPLAIN ANALYZE assertions with 5,000 POs and 400 unrelated driver jobs |
| P3: measure all three pages | Playwright on real HTTP; five search/click samples per page; unchanged 1,000 ms p95 budgets |
| U1: immediate feedback, deduplication and latest selection | Delayed real detail responses, including transport that ignores abort; request-helper concurrency tests |
| U2: cancellation, clearing, tabs, fresh refresh and error retry | Playwright input cancellation, item search, filters, rapid tab changes, detail errors and failed-refresh retries |
| U3: avoid unrelated Control panels | Browser request inspection; shared navigation/alerts/event-stream requests explicitly excluded |
| A1: preserve access scope and reject malformed identities | Real HTTP Sales/Dispatch permission checks; empty/wrong-yard repository properties; malformed and bigint-boundary identity cases |

## Failures observed and resolved

The released baseline took about 9 seconds for search and 26 seconds for an order
click in the synthetic fixture. The selected-reference plan materialized 401
driver references instead of one, and the normalized PO alias index was not
used. The optimized query filters selected aliases before family matching and
loads large driver/photo payloads only for matched records.

Browser RED checks exposed missing immediate loading feedback, stale detail
responses, uncancelled searches, and nine unrelated Control panel requests.
Repeated rendering of large lists was removed from detail-only updates. A later
rapid-tab test caught the shared Sales/Dispatch busy guard dropping a newer
navigation action; current action sequencing now preserves the latest action.

Timing instrumentation now polls completed browser resources every 10 ms; the
original default polling could add about 500 ms to the baseline measurement.
The latency budget was not raised. Baseline has one sample per page; it is not
a statistically representative baseline p95.

The existing PO fixture failed all three tests before reaching repository reads:
its load record omitted the order reference required by migration 301. The
gauntlet reproduces that failure against the saved original fixture/repository,
then runs the same assertions with the required fixture field supplied.

The first static-check runner assumed the old TypeScript JavaScript API; the
locked TypeScript 7 package uses its CLI. The runner now uses that CLI. Its
strict helper diagnostics were fixed with explicit parameter types and promise
initialization. Coverage exposed missing checks for completed search clearing
and failed-refresh retries; those behaviors now have explicit browser assertions.

## Limits

Browser timings use a disposable synthetic database on this host, with no added
network delay. They are not measurements of a user's internet connection or a
production browser session. The baseline image is recorded separately; a newer
live deployment during development was preserved when assembling this release.

The complete relevant movement suite and two history harnesses run; the entire
application's unrelated suites do not. The old thumbnail test's hardcoded
September asset-version assertion was already stale; the executable secure-photo
hydration test runs, while that unrelated version assertion is excluded.

Static checks compare existing browser/repository lint diagnostics and the
backend dependency graph against the captured baseline, and require zero new
diagnostics. The new request helper is type checked strictly. The large existing
browser scripts are checked with syntax, lint and real Playwright execution.
Changed-line execution coverage is enforced; exhaustive branch coverage is not
claimed. Six persisted manual mutants cover index matching, broad history,
normalization, empty scope, stale responses and swallowed errors. The two
normalization/scope mutants run against the generated property test alone.

No packages changed, so a new dependency audit was not needed. The gauntlet scans
the scoped files for secrets. New functions were reviewed for bounded size;
there is no new network destination, completed-response cache or background job.
The focused suite passed a second time (28 tests). The repeat command supplies
different file ordering, but Node sorts the discovered paths, so randomized
execution order is not claimed. No custom randomized runner was added. Isolation
and explicit fixture teardown were exercised on both runs. No git checkpoint
commits were made in the shared dirty workspace; source hashes identify the run.

## Final exact-image result

At 2026-10-22 01:32:50 UTC, image
`sha256:e4bd306279c18578153908d53595f5048536e5897e5e479684b31fffd59731db`
passed: 38/38 regression tests, the secure-photo hydration check, both history
harnesses, 182/182 changed executable lines, and 6/6 manual mutants. The focused
repeat passed 28/28 tests. Both property-specific mutants were killed. Lint and
types introduced zero new diagnostics; the existing graph has 822 type
diagnostics, and existing browser lint diagnostics remain 12 Control / 2 shared
Sales-Dispatch. The new helper has zero type/lint diagnostics. Secret scanning
passed. All 1,438 runtime files matched the release manifest before validation.

| Page | Initial display (ms) | Search median / p95 (ms) | Order click median / p95 (ms) |
| --- | ---: | ---: | ---: |
| Control | 1127 | 829 / 889 | 198 / 220 |
| Sales | 1008 | 262 / 362 | 154 / 160 |
| Dispatch | 893 | 800 / 867 | 156 / 212 |

There are five search/click samples per page, so this sample p95 is the maximum
of five observations. Initial display has one observation per page. The baseline
single-click observations were 26,537 / 26,157 / 26,200 ms respectively.

The retained audit includes exact versions: Node 20.20.2, Playwright 1.62.1,
fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0 and TypeScript 7.0.2. Full runtime tree
hash: `07eaaab51f40537749e43bd8ce1af93ba423a4ff5ad54d4334bd03233637a38e`.

## Deployment and live diagnostic

Deployed at 01:34:42 UTC with an app-only image update. The live and public
origins returned healthy responses for all three pages; all six public assets
matched their candidate hashes, and anonymous detail requests returned 401.
Runtime configuration and the database/worker/Ollama containers were unchanged.
No database migration was performed. Both `docker ps` and `docker ps -a` showed
only the four production containers after test teardown and deployment.

A separate read-only live diagnostic at 01:35:18 UTC returned the recent-day
list (140 records) in 201 ms, a global search in 231 ms, and selected detail in
132 ms. Each transaction had a four-second statement timeout and 500 ms lock
timeout; no order content was logged. This is one live query sample, not a
production-browser percentile. The reproducible diagnostic command is:

```sh
docker exec -i mbbs-operator-app-app-1 node --input-type=module \
  < server/tools/yard-movement-performance-profile.mjs
```
