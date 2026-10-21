# Dispatch/Stock Request contention and reviewed-notice dismissal

Spec approval: not obtained (autonomous run). [Acceptance specification](dispatch-contention-spec.md).

The performance fix is live: five nonunique expression indexes now match the existing Sales Order and Purchase Order identity predicates. No fleet lock was removed, backend killed, active save cancelled, or NetSuite order changed. The backlog drained naturally during investigation; indexes address the expensive work that prolonged lock ownership. No application restart was needed to activate the database fix.

The separate notice fix adds dismissal for acknowledged source reviews, persists dismissed plan/token pairs in bounded browser storage, and keeps pending/new reviews visible. Dismissal updates only the notice region and submits no save or acknowledgement. The release contains only `public/dispatch.js`, its HTML version change, and migration 234.

## Live evidence

Production read-only profiles before/after, with identical requested references and identical returned state/completion sets:

| Query | Before | After |
| --- | ---: | ---: |
| Sales delivery state | 968 ms | 28 ms |
| Driver completion for requested references | 1,361 ms | 48 ms |
| All Driver-completed references | 699 ms | 42 ms |

EXPLAIN showed 32 full Sales Order scans (14,765 rows each) and 272 Purchase Order scans (1,138 rows each). The existing normalized-reference indexes use `upper()`, while these predicates use `lower()`; the PO OR join also needed its textual internal-ID branch indexed. All 32 state-map entries and 1,640 completed references were unchanged after indexing. These are SQL timings, not browser-render timings.

Authenticated GETs against the running application's actual shared connection pool returned HTTP 200: Special queue 985–1,219 ms; Dispatch bootstrap 106–178 ms; Dispatch order pool 190–338 ms. Thirty one-second samples recorded zero fleet-lock waiters. The temporary diagnostic login was removed. SPREQ-000006 and SPREQ-000007 business hashes were unchanged.

Both app and worker were subsequently deployed as image `sha256:570e0c985caeb905f7c51a65f7962618b28060136b8c7c224a533ca379991688`. Environment, service configuration and database/dependency containers were preserved. Public HTTPS assets returned 200 and exactly matched tested bytes. The index installer verified all five indexes valid and ready.

After that deployment, all 12 authenticated GETs again returned 200: Special queues 1,060–1,478 ms, Dispatch bootstrap 91–106 ms and order pool 209–416 ms. Another 30 one-second samples recorded zero fleet-lock waiters. The diagnostic account was removed again and both protected request hashes were unchanged.

## Verification

- RED: all five index checks failed before the migration; the browser reproduction failed because the reviewed-only notice had no dismiss button.
- Final focused suite: 49 tests, 48 passing, one independently reproduced baseline failure, zero skipped and zero new failures. Includes Driver-completion/save serialization, maintenance/editor races, fulfillment/closure restrictions, Special yard access, browser reload dismissal, storage failure, pending-review preservation and no extra saves.
- Baseline failure: `POB03658: a matched parent update plus a new Driver-completed split stays out of Reconcile Review` raises `DISPATCH_ACTIVE_LOAD_LOCKED`. Reproduced without the added indexes; also present on a fresh isolated database. It remains outside this index/UI change; no assertion was weakened or suppressed.
- Changed browser runtime lines: 34/34 executed, combining actual Chromium coverage and production-function tests. All five migration statements ran in PostgreSQL; rollback and repeat-application rehearsals passed.
- Three independently removed-index mutants were detected and restored. Three notice mutants were independently killed by the property suite: inverted acknowledgement, inverted dismissal filtering, and missing plan scope. Property tests cover arbitrary token sets and reviewed/pending combinations.
- Browser syntax passed; ESLint comparison reports zero new findings. Static type checking is not applied to this existing classic-script global UI or SQL migration; browser execution, syntax, lint and behavioral/property checks cover this scope.
- No dependencies changed, so package/license audit was unnecessary. New runtime capabilities are expression indexes and bounded local display preferences; the dismissal makes no network request. Diagnostic tooling uses existing Docker/Postgres/Node and removes its temporary login.
- Full unrelated application suites were not run. An initial repeated run reused persistent test fixtures and hit duplicate test IDs; verification was moved to a fresh dedicated database. An early property-fixture clone discarded null prototypes; the fixture was corrected to preserve them without changing assertions. A test-runner artifact copy was also corrected. Final results above follow those harness corrections and the final runtime source.

Runtime source-manifest SHA-256: `9673209922256b664343470a1bc4a4c8d8bcb22bba79dac7a65cda725b6b195d`.

Reproduce with `python3 server/tools/dispatch-contention-review.py` using the existing isolated review containers. This recreates only `dispatch_contention_verify`, replays index mutants, runs the focused tests/browser/property/mutation/coverage/lint checks and copies evidence back. `python3 server/tools/dispatch-contention-indexes.py rehearse` reproduces transactional rollback and idempotence in the disposable review database. `verify` checks live index definitions without modifying records.

Raw evidence: `server/test-artifacts/dispatch-contention/` (profiles, EXPLAIN plans, live API/lock samples, test output, baseline failure, mutations, coverage, public hashes); release manifest and preserved-business-data check: `server/test-artifacts/dispatch-contention-release-20260926/`.
