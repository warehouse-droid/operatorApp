# Load completion rounding evidence — 2026-10-22

Spec approval: not obtained (autonomous run). The user authorized completion
checks after every load and supplied the NetSuite rounding formula. The
append-only contract is [load-completion-rounding-spec.md](load-completion-rounding-spec.md).

The final candidate has source SHA256
`4195b92e37a6fca81def286b75542f371d9020d4c98d8db1ee1a3a86d0559e2f`
over the named helper, delivery repository and operator browser script. The
release manifest records all five changed files and the full runtime tree.

Reproduce from the repository root:

```sh
bash server/tools/load-completion-rounding-checks.sh
```

The release run used `LOAD_COMPLETION_SOURCE_ROOT` pointing at the captured
candidate and `LOAD_COMPLETION_BASELINE_SOURCE` pointing at its pre-fix delivery
repository. `LOAD_COMPLETION_EVIDENCE_PATH` retained the concise operational
report. The runner creates an isolated database per test file, shuffles files
deterministically with seed 10636, and removes all disposable resources.

| Check | Final result |
| --- | --- |
| Affected regression corpus | 40 files; 284 tests, 276 passed, eight pre-existing failures reproduced against the captured baseline; zero new failures |
| New acceptance tests | Six unit and six SQL integration tests passed |
| Generated math properties | 400 cases, seed 10636; browser and server parity, complete quantities, missing layer, missing cent and exact non-SQFT behavior |
| Coverage of new arithmetic helper | 24/24 lines and statements; 15/15 branches; 2/2 functions |
| Manual mutation against properties alone | 6/6 killed: omit rounding, floor instead of round, round other UOMs, always floor units, round conversion factors early, admit a different cent |
| Static checks | Backend and browser syntax, helper TypeScript checking, new helper/tests/runner ESLint passed |
| Host isolation | Six budget checks passed; bounded Compose services under `mbbs-tests.slice`; teardown confirmed only the four production containers in both `docker ps` and `docker ps -a`; application health passed |

Spec criteria 1–3 are covered by the SOA10636, mixed-line, partial-load,
different-total, invalid-input and generated-property unit tests, plus server
confirmation limits. Criteria 4–5 are covered by SQL-backed pickup, SO, TO and
group loads, successive partial/final loads, duplicate-load rejection and tiny
missing layers. Criterion 6 is covered by the unchanged posting-rounding,
posting-concurrency, retry, HTTP timing and yard-scope suites, plus rejection
without progress/audit writes. Criterion 7 is covered by historical rounded and
unrounded fixtures and the reviewed five-file release diff. The change adds no
NetSuite request and does not change the posting adapter or its tolerance.

The eight baseline failures remain visible in the operational report: seven
`operator-posting-photos.test.js` cases hit the existing fixture/dispatch-order
reference constraint, and the consolidated native HTTP admission case requires
an unavailable NetSuite connection. They were rerun in fresh databases with the
captured pre-fix repository and produced the same failing test names.

The initial regression run failed nine of 17 checks. The implementation removed
the fractional-layer flooring defect. Existing tests expecting a local 0.1 snap
were revised under the user's exact-match requirement; the spec records the
clarification that posting admission remains unchanged. The first broad run
also exposed fixture interference, resolved by disposable databases per file.
A runner nesting lint error was corrected without changing assertions.

Limits: this is the affected 40-file corpus, not every application suite.
Numerical coverage is for the new helper; the large legacy repository/browser
files were exercised by regression tests without a changed-line coverage gate.
Type/lint checks are scoped, and browser calculation tests execute the actual
script functions in a VM rather than a visual browser session. No live NetSuite
write was used for verification. No dependencies, schema or runtime network
capabilities were added. Tool versions are pinned in package-lock.json:
TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0 and fast-check 4.9.0.

Deployed at 2026-10-22 13:39:29 UTC as
`mbbs-operator-app:load-completion-rounding-20261022` (image
`sha256:2002693937707abbc5ebc97855c9c408badf0ee0cede98bb3b698435b13bdb0e`).
The full live source tree matched the candidate; all three public assets matched
over HTTP; application health passed. Runtime configuration and the database,
worker and Ollama containers were preserved. A rollback image and operational
audit remain in `server/deployments/load-completion-rounding-20261022`.
The first deployment attempt stopped before any container change because an old
Compose file required privileged access; the repository's established `sudo -n`
Compose command completed the release.

The post-release read-only SOA10636 diagnostic confirmed line 559147 at
779.75/779.75 SQFT and line 559148 at 111.39/111.39 SQFT both calculate zero
remaining pallets, layers, sections and pieces. This diagnostic changed no
business data and sent no NetSuite request. Generated test logs, coverage,
mutants, disposable databases, containers and networks were removed; only source
documentation and release/rollback audit records were retained.
