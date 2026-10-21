# BIN Planning implementation and verification

The BIN planner is implemented at `/mbt/planning`. It shares Dispatch's daily
plan, date edit lease, fleet and confirmation workflow. Ordinary Dispatch saves
preserve BIN assignments and work with MBT disabled. Dispatch does not request
MBT capability or pool endpoints during initialization. BIN work appears there
as read-only context with a link to the BIN planner.

The intended single-editor restriction still applies across both pages: another
session can view the date but cannot edit it while its lease is held. Navigating
between pages in the same tab retains the date and lease.

The implementation checks below preceded deployment. The user subsequently
authorized deployment; [deployment evidence](mbt-bin-planning-deployment-evidence.md)
records the live release and migration `235_mbt_bin_planning.sql`.
Concrete planning is outside this implementation.

## Authorized scope and executable specification

[Specification](mbt-bin-planning-spec.md). The user authorized implementation of
the BIN plan, shared drivers/date and one editor, then explicitly required that
Dispatch remain usable. The detailed acceptance checks were authored under that
authorization, not separately approved by the user.

| Specification behavior | Executable checks |
| --- | --- |
| Shared lease, session navigation, revision/digest fence and idempotency | `bin-planning-commands.test.js`, `bin-planning-http.test.js`, `bin-planning-race.test.js`, browser test |
| Ordinary Dispatch saves preserve BIN work, including disabled MBT; MBT preserves ordinary work | `bin-planning-dispatch.test.js`, browser test, existing `dispatch-bin-disabled` and confirmation suites |
| Pool, load creation/edit/delete, assignment, move, sequence, details | Pool, commands, adversarial and browser integration tests; domain unit/property tests |
| Successor enters only the pool; requested windows and pricing stay intact | Driver and Front Desk integration tests; baseline BIN/Front Desk suites |
| Cancel then explicitly replan another date; retain custody and evidence | Commands, driver and capacity integration tests |
| Cancellation versus completion, withdrawn offline events and accepted replay | Two controlled races in driver integration tests, plus lease concurrency tests |
| Whole-day confirmation releases exact current driver generations | Driver, HTTP, browser and adversarial integration tests |
| Peak BIN capacity, driver/truck timing, atomic rollback, post-commit events | Capacity, pool, commands, HTTP and concurrency tests; capacity properties |
| Real authenticated API/browser execution | Exported Express app, PostgreSQL and Chromium in HTTP/browser tests |

The new test files are under `test/mbt/{unit,integration,concurrency,property}`;
their filenames begin with `bin-planning-`. Fixtures are in
`test/mbt/support/bin-planning-fixtures.js`.

## Reproduction and environment

From the repository root:

```sh
docker build -f server/tools/bin-planning-test.Dockerfile -t mbbs-bin-planning-test:20260927 server
python3 server/tools/bin-planning-gauntlet.py
```

The Dockerfile combines the existing local test image and existing application
dependencies, including PDFKit. It installs no new project dependency. It needs
the referenced local images and the existing Playwright browser cache at
`/tmp/return-batch-playwright` (override with `BIN_PLANNING_BROWSER_CACHE`).
This is a reproducible repository entry point, not a promise that those cached
images are available on a fresh machine.

Each check uses a uniquely named internal Docker network and a disposable
PostgreSQL 18 database. Source is mounted read-only; only task artifacts are
writable. The runner disables external writes, sets isolated test mode and
does not load the application's environment file. Test files receive separate
database clones; the retired-confirm repair suite runs directly against its own
disposable `mbt_test`, as its safety check requires that literal database name.
Task-owned containers and networks are removed by the runner.

Recorded tools: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0 and Playwright 1.62.1. No commit was made; unrelated dirty work
was preserved. Mutants run only in temporary source copies, with original-file
hashes checked afterward.

## Final results

Final fresh run: **2026-09-27 04:00:39–04:06:44 UTC**. The entry point exited
**0**, with **zero unexpected failures** and the four explicitly classified
Dispatch failures below. It does not label the broader suite entirely green.

| Layer run by the entry point | Actual final result |
| --- | --- |
| Feature suite under c8 (`bin-planning-coverage.mjs`) | 42/42 tests, 13 files |
| Existing BIN/driver/Front Desk compatibility (`bin-planning-suites.mjs baseline`) | 155/155 tests, 37 files |
| Broader Dispatch (`bin-planning-suites.mjs dispatch`) | 228 passed, 4 failed, 232 tests in 37 files; comparison matches all four failures |
| Retired-confirm repair (direct Node test) | 11/11 tests |
| Feature suite in reverse file order | 42/42 tests; fresh isolated databases |
| Coverage of all seven new backend planning modules | Lines/statements 872/872 (100%); functions 58/58 (100%); branches 409/452 (90.48%) |
| Three fast-check properties | 1,000 cases each; seeds 9272026, 9272027, 9272028 |
| Manual mutation (`bin-planning-mutations.py`) | 6/6 faults killed; 3/3 applicable domain faults also killed by properties alone; 9 executions total |
| Static (`bin-planning-static.mjs`) | 49 JS syntax checks; 0 lint errors; 0 type errors in changed MBT modules; 254 diagnostics in the full imported graph |
| Secrets (`bin-planning-secrets.mjs`) | 61 files; 0 unexpected findings; 2 exact-line reviewed false positives |
| Real browser and API | Chromium/Express/PostgreSQL workflow passes; no browser page errors or tested axe violations |

No tests were skipped or cancelled in these selections. The browser workflow
assigns two visits to a one-slot BIN truck, drags and buttons their sequence,
confirms through the real shared HTTP handler, rejects a second browser's edit
attempt, disables MBT, navigates to Dispatch and saves an ordinary load without
any MBT API request. It then returns with the same lease, creates another BIN
load, moves a visit, opens history, cancels to the pool and searches for it.

The six mutants remove BIN edit protection, reject exactly-full capacity,
reverse sequence direction, skip assignment withdrawal, disclose unpublished
driver work, and skip the final lease-expiry assertion. All failed behavioral
assertions. The three pure-domain mutants were separately run against only the
property suite; database lifecycle faults were tested through integration/race
examples, not claimed as property-suite kills.

The run verified that the 61 manifest files did not change during execution.
Their aggregate SHA-256 is
`deda4da0f4abc014f0f0cde7685ad96ab031ae245dec789d92f924398f5dee82`.
This identifies the scoped files, including shared files with prior work, not
the entire repository. The evidence document is outside that frozen manifest.

Raw evidence:

- [Run summary and per-file hashes](../test-artifacts/mbt-bin-planning/final/result.json)
- [Test counts](../test-artifacts/mbt-bin-planning/final/test-counts.json)
- [Coverage](../test-artifacts/mbt-bin-planning/checks/final-coverage/coverage/coverage-summary.json)
- [Static results](../test-artifacts/mbt-bin-planning/checks/final-static/static.json)
- [Dispatch comparison](../test-artifacts/mbt-bin-planning/comparison/results.json)
- [Mutation results](../test-artifacts/mbt-bin-planning/mutations/results.json)
- [Browser screenshot](../test-artifacts/mbt-bin-planning/checks/final-coverage/bin-planning.png)

Detailed per-layer logs are in `test-artifacts/mbt-bin-planning/final/`.

## Regression limits

The broader Dispatch selection has four failing assertions in three files. The
comparison script repeats those files with the new BIN preservation and driver
publication filters disabled in a disposable copy. The same four assertions
fail in both runs:

- `history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders`
- `DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries`
- `DP-13 and DP-16: checkpoint list is metadata-only and compact reads/commands record bounded timings`
- `DP-33 frontend: active CO projection retains every current relationship pickup`

This comparison is not a clean pre-task Git baseline. Their assertions were not
changed. The gauntlet checks the exact names, completed-file count, failure
count and process status; any additional failure fails the verification run.

The full imported TypeScript graph is not clean. Its remaining diagnostics are
outside the changed MBT modules and also appeared in the earlier in-task type
check after normalizing line numbers. This is not a claim that a full project
type check passes or a clean pre-task type baseline was captured.

Coverage measures all seven new backend planning modules. Changed-line coverage
for every legacy file and browser JavaScript branch coverage were not measured:
the checkout contains extensive overlapping work, and the browser check uses
the existing uninstrumented application. Browser behavior is checked against
real APIs, with a saved screenshot and axe assertions; axe color-contrast checks
are disabled. No mobile browser matrix, production load benchmark or exhaustive
mutation campaign was run. No latency budget was specified. Manual mutants test
six chosen faults; they do not establish a project-wide mutation score.

Only the related BIN, Front Desk, driver and Dispatch selections were run, not
every unrelated application suite. The migration was rehearsed on disposable
databases, not a production-data copy. These limits remain explicit rather than
being included in a claim of complete project health.

## Failures found and resolved

Persisted RED evidence is in `test-artifacts/mbt-bin-planning-*-red.log`, including
commands, HTTP, driver publication, Front Desk, confirmation and browser runs.
Checks exposed missing lease enforcement, staged-driver visibility, successor
pool release, ready-but-unassigned Front Desk handling, and stale confirmation
requirements. Those behaviors now have executable regressions.

Expanded browser navigation found that Dispatch can persist placeholder truck
IDs such as `T3`; capacity validation now queries database trucks only for loads
containing BIN visits. Dispatch's derived stop timing is ignored when comparing
protected BIN identity, then its exact authoritative BIN stops are restored.
The MBT confirm endpoint delegates to the existing Dispatch HTTP confirmation
handler, preserving ordinary validation and follow-up behavior.

Prior disabled-BIN expectations rejected ordinary saves merely because BIN work
was present. They were updated to the user's explicit compatibility requirement;
attempted BIN edits, insertion, removal and restoration retain zero-write
assertions. The specification records this behavior change. An incorrect extra
test assertion about an unplaced SO was removed because Dispatch intentionally
persists placed orders only; the ordinary saved-load assertion remains.

Existing frontend extraction harnesses now load the new protection helpers.
Their behavioral checks remain intact. Cache-version expectations reflect the
new assets. The final runner propagates child test failures, so a completed
process cannot silently mask a failed test file.

The secret scanner initially matched its own reviewed-pattern literals. Its
exceptions now match the entire reviewed line by SHA-256. The two reviewed
findings are an existing dynamic HTML token attribute with no literal secret
and the disposable database credential in the task runner. Changed values must
be reviewed again; no broad file exemption was added.
