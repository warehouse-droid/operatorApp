# CE94487 stale delivery address — evidence

The September 12 plan was repaired and the hotfix deployed. GOA-8353-8354 now
routes to **145 Valleymede Dr, Richmond Hill**; SOB120030 routes to **39 Estoril
St, Richmond Hill**. The live Driver job projection has distinct dropoff jobs
for those two addresses, in the existing order. The plan advanced from revision
12 to 13. Applying the repair again returns `alreadyCorrect: true` at revision 13.

The edit handler previously updated only `address`, while routing preferred
`destinationAddress`. Group source refreshes also retained those stale parent
address aliases. The fix updates all delivery aliases after an acknowledged
edit and refreshes the representative member's inherited address on SO groups,
preserving deliberate group-only addresses. PO, TO and CO projection semantics
are unchanged.

Spec: [dispatch-stale-address-spec.md](dispatch-stale-address-spec.md).
Spec approval: **not obtained (autonomous run)**. The tests and specification
were authored by the same agent; this is bounded evidence, not independent proof.
Tier 3 applies to the live repair's concurrency and rollback guarantees.

## Final evidence

Evidence directory: `test-artifacts/stale-address/final-4SC1SI`.
Entry point: `bash tools/dispatch-stale-address-gauntlet.sh` from `server`, or
`bash server/tools/dispatch-stale-address-gauntlet.sh` from the repository root.
The runner requires the cached Docker test images recorded in `images.txt` and
the task's disposable `mbbs-stale-address-db-1` database (created from
`docker-compose.mbt-test.yml`, project `mbbs-stale-address`). The saved production
baseline source files are retained under `test-artifacts/stale-address/baseline`.
For the incident replay, pass
`STALE_ADDRESS_PLAN_FILE=/app/test-artifacts/stale-address/live-plan.json`.

| Requirement | Evidence | Result |
| --- | --- | --- |
| SA-1 acknowledged edits and separate visits | `dispatch/frontend/dispatch-stale-address.test.js`; actual browser edit/group flow | Pass |
| SA-2 source refresh, representative identity, manual address | `dispatch/unit/dispatch-stale-address.test.js`; real database source reconciliation | Pass; 100 seeded property examples |
| SA-3 cargo, input immutability, PO/TO/CO boundaries | Unit/property cases, PO HTTP override test and existing Dispatch contracts | Pass |
| SA-4 rollback, stale revision, started work, late failure, timings | `dispatch/integration/dispatch-stale-address.test.js` | 6/6 pass |
| SA-5 browser and live Driver behavior | `mbt/e2e/dispatch-stale-address.spec.js`; live `planJobsForDrivers` projection | 2/2 browser tests pass; two live dropoff jobs |
| Focused tests, combined | `covered.log` | 15/15 pass, 0 skipped |
| Existing targeted regressions | `regressions.log`, `regressions-baseline.log` | 49 pass; 2 identical pre-existing CO failures; 0 new failures |
| Full MBT suite | `full-mbt.log` | 462 files; 2,299 pass, 0 fail, 1 existing opt-in skip |
| Full legacy harnesses | `legacy.log` | 134/134 harnesses pass |
| Mutation testing | `tools/dispatch-stale-address-mutations.mjs`, `mutations.log` | 10/10 killed; 2/2 selected mutants also killed by the property test alone |
| Changed executable lines | `coverage.log` | 138/138 executed: group projection 14/14, browser 5/5, repair 119/119 |
| Lint and syntax | `lint.log`, release build's `node --check` | Pass, no lint warnings |
| Type regression | Exact comparison of `types-baseline.log` and `types-current.log` diagnostics | 233 existing errors in each; no new diagnostics |
| Secrets and source integrity | `secrets.log`, `source.sha256`, `source-check.log`, live source hashes | Pass |

Coverage uses the existing `tools/sales-order-cargo-coverage.mjs` changed-line
checker after the live rollback rehearsal and CLI invocation, with V8 files
stored in the final evidence directory. It reports executed lines, not complete
branch coverage. Run `node tools/sales-order-cargo-coverage.mjs
test-artifacts/stale-address/final-4SC1SI` in the recorded test image to reproduce
the calculation.

Actual tools: Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, fast-check 4.9.0,
Playwright 1.62.1. No dependencies, database schema, or integration configuration
were changed. The four released file hashes are in `source.sha256`; the runtime
and HTTP-served script were verified against them.

## Deployment and repair

Release: `mbbs-operator-app:stale-address-20260911-v1`, layered over the existing
`operator-ui-20260911-v1` image. Only Dispatch JS/HTML, the group repository and
the guarded repair CLI were copied. Both the app and webhook worker use the
release. Environment fingerprints match before/after. The database and Ollama
containers retained their IDs/start times. `/health` returns `ok: true`.

Private records live in `docker/backups/stale-address-20260911`:
`repair-final-rehearsal.json`, `repair-applied.json`, `repair-idempotence.json`,
`repair-before.json`, `preflight.json`, `postflight.json`,
`live-verification.json` and `live-source-hashes.json`.

The rollback rehearsal executed and rolled back every database write. Applying
archived the prior snapshot, updated the plan and global group atomically,
recomputed the single affected load's derived times with the real browser's
normal local estimates, refreshed its assignment index, and wrote a dispatch
audit. The source order rows, cargo, stop IDs, stop order and driver records
were preserved. There were zero driver execution records for this future plan.
The previous release remains available through `compose.rollback.yml`; any
data reversal should use the selective backup rather than overwrite live data.

## Failures and limits

- The initial regression tests failed on the stale addresses before the fix.
  The initial repair stub failed the repair acceptance tests before implementation.
- A live rehearsal detected the user had reassigned the group in revision 12.
  It rolled back; the spec was visibly extended to require an exact-revision
  browser timing projection. That path subsequently passed tests and rehearsal.
- The first broad run had six failing files from missing test configuration or
  incorrect mounted paths. A concurrent legacy run was interrupted by the
  test database clone mechanism; a later attempt found an old test edit lease.
  The final runner uses the complete environment, a dedicated disposable
  database, explicit resets and sequential database suites.
- The two existing global-derived CO tests fail identically with the untouched
  production group repository: null `type` and null `childOrders`. Their
  assertions were not changed; the runner compares the exact failing names and
  errors against that baseline. The PO source-contract assertion was updated to
  require the new routing-field assignment; its real HTTP and browser behavior
  remain tested.
- The full MBT run retains the existing opt-in skip for migration 175's cutover
  test (`MBT_CROSS_CHARGE_MIGRATION_CUTOVER_TEST` was not enabled); this repair
  changes no migration. The legacy manifest excludes live NetSuite access and
  the workbook-dependent Smart SCM harness; all 134 included harnesses passed.
- The first live CLI invocation lacked its timing input in the new container;
  it failed before entering the repair. Copying the already verified input
  allowed the successful guarded invocation.
- The repair deliberately refuses started driver work, changed source addresses,
  stale revisions, changed stop identities, overlapping intervals, or additional
  loads requiring a wider driver timing projection. It does not make NetSuite
  writes. Timing uses the application's normal local estimates; a fresh Google
  refinement remains the existing optional application behavior.
- Dependency audit is not applicable because dependencies were unchanged.
  No migration was needed. Focused tests ran in different file orders; mutation
  runs restored source hashes and reran the passing baseline. The complete
  repository's pre-existing type errors remain outside this change's scope.
