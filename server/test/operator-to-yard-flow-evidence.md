# Operator yard-to-yard TO flow evidence

The implemented sequence is local outbound preparation, local truck loading,
destination-yard Receiving, local receipt and effective Driver completion,
IF posting and verification, then IR posting. NetSuite delivery quantities and
statuses do not substitute for the physical milestones.

Spec approval: not obtained (autonomous run). Tier 3 was selected because the
change controls inventory posting and durable background work. The acceptance
specification is [operator-to-yard-flow-spec.md](operator-to-yard-flow-spec.md).
This report establishes the tested boundaries; the user has not independently
reviewed the specification.

## Acceptance criteria and evidence

| Criterion | Executed checks |
| --- | --- |
| Outbound follows local progress across remote statuses | `operator-to-yard-flow.test.js`: outbound preparation across NetSuite statuses; remote fulfilled quantity does not imply loading |
| Receiving appears only after actual local loading, at the destination | The same integration file: Receiving sources, lists, item search, wrong-yard checks, direct unloaded receive rejection, tracked TO refresh before receiving status |
| Receipt is capped by loaded quantity and cannot repeat | Partial receiving and line-confirmation cases; background-posting duplicate receipt regression; generated repeated-item capacity property |
| IF requires matching load, full physical receipt and Driver drop-off | IF waiting case; required-and-sufficient property; background-posting wrong-load and withdrawn-completion cases |
| IR waits for confirmed IF | IR admission ordering and missing IF cases; verified-IF property; background finalization and uncertain retry regressions |
| Recheck evidence and retain concurrency/idempotency safeguards | Deleted-receipt pre-transform case; existing independent concurrent workers, command replay, immutable quantities, uncertain posting, and forged-finalization tests |
| Remote sync preserves local work | Header-by-ID reader, active tracked-order discovery, no inferred loaded quantity, physical receipt versus remote received quantity, and preserved drafts/statuses tests |
| Direct customer transfers, PO receiving and authorization survive | `to-linked-so-completion.test.js`; existing receiving allocation/completed tests; real HTTP load/receipt, replay, wrong-yard and Admin queue checks |
| Migration preserves immutable records | Migration 279 reapplication test; existing background queue migration rollback regression |

Test files are in `test/mbt/integration`, `test/mbt/unit` and
`test/mbt/property`; the fixture in `test/support` uses real PostgreSQL records.
Only the NetSuite network boundary is substituted. The HTTP check starts the
actual Express app and saves a load and receipt while direct NetSuite access
is disabled.

## Reproduction

From the repository root:

```sh
bash server/tools/operator-to-yard-flow-gauntlet.sh
```

The entry point reconstructs the pre-change TO sources from the persisted
patch, saves the final source snapshot, compares types, runs every discovered
non-E2E MBT test file against an isolated disposable database, then runs the
focused coverage, mutation, reverse-order, and secret checks. A cached baseline
and already-running full comparison can be finished with the `resume` argument.
It fails if there are unresolved new failures, new type errors, uncovered
changed executable lines, or source changes outside the exact recorded
concurrent edit.

Toolchain: Node 20.20.2, PostgreSQL 18 Alpine (the image digest in the standard
test Compose file), TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0,
and Playwright 1.62.1. Packages were installed from the existing lockfile into
the task's test-artifact tooling directory; no dependency or lockfile changed.
Browser system dependencies were installed in a bounded disposable test image
for the existing browser tests. Its exact image ID is retained in the artifacts.

All Docker test work uses the standard isolated Compose configuration,
`mbbs-tests.slice`, bounded CPU/memory/PIDs/tmpfs and an init process.
The runner registers teardown before creating containers and calls
`docker compose down --volumes --remove-orphans` on success or failure.

## Final results

Final run: 2026-10-09. The measured results are retained in
`test-artifacts/operator-to-yard-flow/results.json`, with raw logs and original
per-file baseline and candidate results beside it.

| Layer | Actual result |
| --- | --- |
| Focused tests and real HTTP | 77/77 passed, 0 failed |
| Full non-E2E MBT comparison | Baseline: 923 files, 5,389 reported tests, 111 failed files. Candidate: 926 files, 5,411 reported tests, 110 failed files before replay. Zero unresolved new failures; one concurrent-edit boot failure replayed successfully, leaving 109 previously failing files |
| Types, same unrelated code on both sides | 866 baseline errors, 866 candidate errors, 0 new errors attributable to the TO patch |
| Syntax, targeted ESLint and complexity | Passed; 0 lint warnings; complexity limit 12 for the transfer-posting modules |
| Added/replaced executable JavaScript lines | 133/133 exercised; 0 uncovered |
| V8 branches beginning on changed lines | 97/101 exercised; four unexecuted branches documented below |
| Manual mutation, full focused suite | 8/8 injected bugs detected |
| Manual mutation, property suite alone | 4/4 applicable injected bugs detected; the other four target integration-only behavior |
| Generated TO properties | 3 properties, 200 + 100 + 150 fixed-seed examples (450 total), plus 2 adversarial regression tests |
| Order sensitivity | Same 77/77 tests passed with reversed file order |
| Secret check | Changed-line patch and 11 new code paths checked; 0 high-confidence findings |
| Teardown | `docker ps` and `docker ps -a` contain only the four production containers. All task test containers, database storage and networks removed. App, database and Ollama healthy; webhook worker running |

Each command is persisted in the entry point and its referenced runners. The
application source state is identified by SHA-256 hashes of the eight touched
modules and migration in `source-hashes.json`; the hash computation is in
`operator-to-yard-flow-checks.mjs`. Full-suite starting hashes and the final
snapshot hashes are retained separately. Source comparison rejects any
unrecorded change to a touched module.

The eight injected bugs bypass receipt, bypass verified IF ordering, ignore
dispatch scope, remove loaded-quantity caps, let remote received quantity
replace physical receipt, overwrite local loaded quantity from remote progress,
prevent destination refresh before a receipt, or remove the new waiting status
from the database constraint. Each mutation ran in a disposable source copy.

Initial RED evidence observed seven behavioral failures in eight acceptance
tests. Additional RED runs captured the tracked-reader filter, sync refresh,
missing own Operator record, and remote-receipt overwrite defects. The raw
`red*.log` files retain their assertions and skipped test-name selections.
One intermediate type check found a missing type predicate in the new waiting
helper; adding the predicate removed that new diagnostic without changing
runtime behavior or test assertions.

The four uncovered branch entries are in `receiving-repository.js` at lines
649, 1594 and 1595 (two). They are the false side of a receipt-map choice that
is always populated for the PO path, a zero-quantity fallback excluded by
validated positive receipt payloads, and legacy original-quantity fallbacks
outside the ordinary projected TO path. No test was added solely to inflate
branch coverage. The SQL migration is verified by database tests rather than
the JavaScript coverage count.

## Baseline and concurrent workspace changes

The repository had extensive unrelated work before this task. Original
baseline failures and compiler diagnostics are retained, rather than being
repaired by this TO patch. The original full-suite baseline used its captured
source; the type comparison uses the same unrelated final code on both sides,
with only this TO patch reversed on the baseline side.

Separate customer-webhook work changed the shared `server.js` during the full
candidate run. The exact import, comment and middleware-registration delta is
recorded in `concurrent-server-change.patch`; the TO code and the other seven
touched modules were unchanged. One existing group-action test started between
the middleware addition and its import and failed with an undefined-router
error. Its original failure is retained; its isolated replay on the completed
source snapshot passed both tests. Focused checks use that same saved final
snapshot. This full-suite result is not a claim that every test used one
unchanging version of the unrelated code.

The original compiler baseline had 865 errors. Concurrent customer-webhook work
added `src/netsuite-customer-webhook.js: Object is possibly 'undefined'`. The
fair type comparison retains the concurrent code on both sides and does not
hide or edit that error.

## Confidence limits and skipped layers

- No live NetSuite transform or transaction was executed. The real integration
  boundary is checked against controlled source and verification responses.
- The change targets ordinary yard-to-yard TOs. Direct-to-customer TOs preserve
  their existing linked-SO completion contract. Locally split TOs without synced
  destination lines are not synthesized or covered by a new end-to-end case.
- The status migration is additive; it does not repair historical loaded or
  received flags, reactivate old records, or automatically replay old jobs.
- Missing, ambiguous or reassigned dispatch evidence requires the existing
  Admin attention/retry flow. An unrelated load cannot supply its evidence.
- Broad browser E2E projects outside the non-E2E MBT discovery were skipped:
  no browser UI was changed. The real authenticated HTTP path was exercised.
- Dependency audit and license review were skipped because the dependency graph
  did not change. Diff and new-file secret checks were run. No new network,
  subprocess, filesystem or environment capability was added to application
  code; test tooling uses disposable subprocesses and files.
- No checkpoint commits were made in the pre-existing dirty workspace. Exact
  touched-source hashes and immutable baseline snapshots identify the tested
  source; mutants run in throwaway copies and leave application sources intact.
- Tests verify the specified physical sequence and existing durable worker
  behavior. They do not prove every production timing, historical-data repair,
  or live NetSuite failure mode.

At the end of the original implementation verification, no live deployment or
production repair had occurred. The later user-authorized activation and all-TO
reconciliation supersede that state. See
[operator-to-yard-flow-deployment-evidence.md](operator-to-yard-flow-deployment-evidence.md)
for deployed source hashes, 118 exact-candidate checks, verified Receiving
exceptions, historical preservation, idempotent repair and final live evidence.
