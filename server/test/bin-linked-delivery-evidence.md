# Linked BIN delivery planning evidence — 2026-10-23

User requirement: planning a collection automatically plans its linked receiving
BIN delivery. Spec: `test/bin-linked-delivery-spec.md`; approval not obtained
(autonomous implementation under the user's instruction). Tier 3 for shared-bin
claims, transaction rollback and concurrent planning. No dependencies or commits.

## Behavior verified

- Collection-only board and direct assignment include collection, dump, receiving
  cargo pickup and delivery on one load with one physical bin. Retries are stable.
- The real Chromium planner adds both legs by drag/drop, moves and removes both,
  allows immediate replanning before autosave, and keeps their dependency order
  during optimization even when the delivery's requested window is earlier.
- Cancelled receiving orders and standalone linked-delivery assignment are blocked.
  Missing cargo pickup, stale revisions, split loads and reversed order roll back.
- Search/pagination includes the linked card. The bin's post-dump source and material
  pickup have separate labels. Customer windows and unrelated loads are preserved.
- Concurrent saves produce one complete winner. Completed collections permit their
  remaining delivery; existing overnight routes and driver custody still work.

## Final exact-candidate results

- 331/331 tests passed across 76 BIN planning, workflow, cargo, driver, concurrency,
  property and browser files; no failures or skips. Focused reverse order: 11/11.
- Five deliberate mutants killed, including three by properties alone: omitted
  auto delivery, reversed insertion, split-load allowance, omitted direct-command
  pairing, and omitted browser pairing. New properties: 250 generated cases,
  seeds 3445 and 150, plus fixed invalid-state invariants.
- Changed executable line coverage: 162/162; measured changed branches: 129/131.
  Browser sources were checked against candidate bytes and checkpointed before
  navigation. Branch coverage is not claimed to be complete.
- Syntax: six JS files. Zero lint/type errors, baseline type errors or secret findings.
- Toolchain: Node v20.20.2, TypeScript 7.0.2,
  ESLint 10.8.0, c8 12.0.0,
  fast-check 4.9.0, Playwright 1.62.1, pg 8.21.0.

RED was observed before the implementation: missing receiving stops, separate
assignment and misleading pickup labels. Additional browser RED demonstrated
incorrect optimization and immediate replanning; focused RED also caught a
cancelled receiving order and loss of the blank destination's input validation.
Fixture SQL errors were corrected before counting those RED cases. Existing
same-bin tests now assert automatic assignment instead of a second manual command.
The overnight test recreates an older saved route through the single-visit fixture
primitive and retains its confirmation/custody/reference assertions.

One initial broad HTTP run returned 500 and stalled after failure; its process was
terminated, and its stack was removed. Baseline and candidate isolated checks then
passed. The test now consumes its error response and closes all HTTP connections;
all assertions remain. The final complete run passed without exceptions or retries.

Reproduce with `DISPATCH_SOURCE_RUNTIME` and `DISPATCH_SOURCE_MIGRATIONS` pointing
to the candidate, then `bash docker/run-bin-linked-delivery-checks.sh` from the
repository root. Detailed compact hashes, results, tool versions and cleanup proof
are in `deployments/bin-linked-delivery-20261023/validation.json`.

## Deployment and cleanup

Deployed mbbs-operator-app:bin-linked-delivery-20261023 at 2026-10-23T17:18:20Z, over the concurrent
`regular-linked-so-status-20261023` release. Seven runtime files match the validated
hashes; app configuration and other services were preserved. No migration or saved
plan rewrite. Health, planning/frontdesk/driver pages and authenticated API boundary
checks passed; the live planning HTML uses the new cache key.

Read-only verification confirms October 21 plan 365 remains revision 110 with
collection → dump → Gravel pickup → delivery, including BIN00002X-1C and BIN00004D.
All tests used the bounded disposable runner and registered teardown. Final
`docker ps` and `docker ps -a` contain only the four production containers; no test
networks or volumes remain. Generated test logs, coverage, databases and temporary
mutants were deleted. Only source evidence and operational release/rollback audit
records remain. This is the scoped BIN regression selection, not every app suite.
