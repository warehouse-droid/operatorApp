# SCM Ultimate Urgent packing — evidence

Deployment update, 2026-10-06: the user explicitly requested deployment with
Delivery Requests and a short cutover. Both are now live after fresh combined
validation. The measured health interruption was 5.032 seconds. See the
[deployment evidence](../deployments/delivery-scm-20261006/DEPLOYMENT.md).
The report below preserves the earlier release-ready decision and validation.

The enhancement is implemented, validated, and packaged. The user selected
**Keep the release ready**, so production deployment is deferred. Automatic
approval review previously rejected the cutover because the enhancement/replay
request did not explicitly authorize the live restart. The apply command was
not executed. The decision is recorded in the release directory.

The rule packs Ultimate Urgent quantities together within compatible pickup,
type, and route groups, reserves full urgent loads, and uses only the urgent
remainder for lower-priority filler. Full urgent loads sort ahead of mixed
urgent loads within the existing manual/replenishment priority classes.

Only three runtime files change: `src/smart-scm-planning-repository.js`,
`public/scm-smart-proposals.js`, and the cache-busted script reference in
`public/scm-smart.html`. No dependencies or migrations are added.

## Assurance and reproduction

- Tier 3; specification: [scm-ultimate-packing-spec.md](scm-ultimate-packing-spec.md).
- Spec approval: not obtained (autonomous run). The user authorized the
  priority enhancement and replay; independent review of the executable
  specification did not occur. This limits the confidence claim to the
  recorded behaviors and invariants.
- Repository HEAD: `a4b73e073c9217bc8629abea296ab8784cc2cd43`.
- Verified implementation/test/tool/spec source hash:
  `862b3a52e036f08cc60b02814619c207ec521b6cdafd07a208478f8e996481f6`.
  The source manifest covers 22 files and was checked again after the final run.
  This generated evidence document is separate from that source state.
- Runtime baseline: live image
  `sha256:b431410e7af165a7ce2638f3951574a02a3a472eab60d5981db8160135569e14`.
- Verified release image:
  `mbbs-operator-app:scm-ultimate-packing-20261005-v1`,
  `sha256:a503f88e149fa9269b281a53a84d6bc7bd41d305a9d681f2038608f6372e5c5b`.
- Test image: `mbbs-regular-v2:test`,
  `sha256:087db416dc024ccf13e0b7ea732853e2e93ce3561937f1e301a540a9aab098c7`.
- Toolchain recorded in the final run: Node 20.20.2, ESLint 10.8.0,
  TypeScript 7.0.2, fast-check 4.9.0, c8 12.0.0.

Run from `server/` with the captured fixtures and locally cached test images:

```sh
bash tools/scm-ultimate-packing-gauntlet.sh
```

This entry point preserves previous evidence, prepares a fresh source manifest,
runs the baseline and candidate in disposable isolated Compose projects, and
removes all containers, database storage, and project networks afterward.
All test workloads inherit `mbbs-tests.slice`, bounded memory/CPU/PIDs/tmpfs,
and init from the standard isolated Compose configuration. Teardown is
registered before creation. No production credentials or data volumes enter
the test containers.

## Specification to evidence

| Behavior or invariant | Executable check | Status |
|---|---|---|
| Full urgent loads resist lower-priority filler | Unit: seven urgent pallets of weight 9, capacity 30; two pure loads plus a mixed remainder | Pass |
| Truck-count preference cannot fragment urgent quantities | Unit: six urgent pallets of weight 1 plus three normal pallets of weight 8, capacity 10 | Pass |
| A fitting urgent destination stays together | Captured plan 429 unit, 1,000 generated conservation/concentration cases, all 20 plan replays | Pass |
| Whole urgent remainder groups combine only when capacity and stops permit | Unit cases and 100 generated cases, overloaded/needlessly-separated mutants | Pass |
| Full urgent cards precede mixed cards despite score/destination | Browser-script VM unit, 150 generated ordering cases, disposable DB integration | Pass |
| Manual/replenishment priority remains intact | Browser ordering unit and affected SCM suites | Pass |
| Physical pallet weight counts and quantities/allocations are conserved | Unit and generated invariants, all replay groups, physical-weight/allocation mutants | Pass |
| Fractional purchase support remains intact | Fractional unit and existing purchase-stock suites | Pass |
| Partial vendor/hub routing survives | Unit, 200 generated Gormley cases, route mutant, replay stop/order checks | Pass |
| Invalid-input errors and frozen input are preserved | Unit errors, frozen allocation input, 100 generated nonpositive-capacity cases | Pass |
| No-Ultimate behavior remains intact | 178 replay groups equal the baseline packing exactly | Pass |
| Repeated/reordered inputs preserve grouping | Generated properties and every replay group | Pass |
| No new affected-suite failures | 95 files against baseline, then the same 95 files in shuffled order | Pass |
| Real endpoint returns the captured urgent quantity correctly | Isolated application, real persistence, SCM login and planning-run GET: 25 pallets in one load | Pass |
| Replay does not change issued orders or historical plans | Read-only production capture, offline fixtures, disposable test DB only | Pass |
| Release includes only scoped runtime files | Live baseline capture, scoped Docker overlay, exact image file hashes | Pass |
| Test resources are removed | Pre-registered teardown; project container/network/volume checks; docker ps and ps -a; production health | Pass |
| Live cutover, served release assets and post-release production health | User selected Keep the release ready; production deployment is deferred | Unverified |

## Final fresh run

All results below come from the completed gauntlet after the last runtime,
test, and executable tool edits. Raw output is retained under
`test-artifacts/scm-ultimate-packing-20261005/final/`.

| Layer | Command/script inside the bounded test stack | Result |
|---|---|---|
| Focused unit/property/integration | Node test runner on the three new test files | 18 passed, 0 failed |
| Generated properties | `test/mbt/property/scm-ultimate-packing.property.test.js` | 6 properties, 1,850 cases; fixed seeds 4292026, 42928, 42915, 4290, 3623026, 429150 |
| Affected SCM suites | `tools/scm-ultimate-packing-suites.mjs` | Baseline and candidate each: 95 files, 422 passed, 12 pre-existing failing cases in 4 files; 0 new failures |
| Suite ordering | Same suite runner with `SCM_PACKING_SHUFFLE=1` | 95 files, same baseline failures, 0 new failures; deterministic shuffle seed 429 |
| Lint and complexity | `tools/scm-ultimate-packing-static.mjs` | 0 new diagnostics; repository file 118 existing diagnostics, browser file 86; new function complexity budget 12 |
| Existing TypeScript project | Same static script; baseline/candidate `tsc --project tsconfig.mbt.json --noEmit` | 0 new errors; baseline 533 diagnostics, candidate 274; both exit 1 |
| Changed executable lines | `tools/scm-ultimate-packing-coverage.mjs`, raw V8 coverage | 65/65 covered: backend 50/50, browser 15/15; no misses |
| Manual mutation | `tools/scm-ultimate-packing-mutations.mjs` | 10/10 killed by focused units and independently 10/10 by properties alone |
| Saved plan replay | `tools/scm-ultimate-packing-replay.mjs` | 20 plans, 291 compatible groups, 955 stored automatic proposals; every conservation, capacity, stop/order and urgency assertion passed |
| Application execution | `tools/scm-ultimate-packing-runtime.mjs` | Health 200, login 200, anonymous planning 401, authenticated planning 200; captured 25 urgent pallets in 1 load; HTML and script served |
| Secrets/capabilities/dependencies | `tools/scm-ultimate-packing-review.py` | 0 scoped-diff secret matches, 0 new external runtime capabilities, 0 dependency/schema changes |
| Release image | `tools/scm-ultimate-packing-deploy.py build` | Exact hashes for all 3 runtime files; 2 JavaScript syntax checks; disposable container removed |

Pre-existing failures are recorded verbatim in the baseline suite summary and
its linked logs. The four files are `src/smart-scm-blanket-ui-harness.js`
(old exclusion asset expectation), `src/smart-scm-harness.js` (missing active
item-master fixture), and the regular-stock resolution browser/HTTP integration
files (existing isolated database hostname assumptions). Candidate and shuffled
runs retain the same failing case names and diagnostics.

The legacy planning/browser JavaScript is not fully checked by the repository's
TypeScript project. The zero-new-error result does not imply those files are
fully typed. Changed-line coverage is an execution check; it is supplemented
by assertions and independent mutation kills, not a claim of complete proof.

## Replay truck counts

These are baseline-versus-enhanced packing runs over the same captured proposed
quantities and frozen route rules. Stored plans can differ from a replay after
later edits or confirmations; this is not a reconstruction of historical
forecasts. The raw capture is retained. Thirty-four lines' confirmation/residual
fields were normalized only in offline inputs to initial planning state.

| Plan | Baseline replay | Enhanced replay | Change |
|---|---:|---:|---:|
| 429 | 54 | 54 | 0 |
| 428 | 54 | 55 | +1 |
| 427 | 54 | 55 | +1 |
| 426 | 50 | 51 | +1 |
| 425 | 57 | 58 | +1 |
| 424 | 58 | 58 | 0 |
| 423 | 60 | 61 | +1 |
| 422 | 44 | 45 | +1 |
| 421 | 43 | 44 | +1 |
| 420 | 43 | 44 | +1 |
| 419 | 43 | 44 | +1 |
| 418 | 42 | 42 | 0 |
| 417 | 59 | 59 | 0 |
| 416 | 41 | 41 | 0 |
| 415 | 42 | 42 | 0 |
| 414 | 42 | 42 | 0 |
| 413 | 44 | 44 | 0 |
| 412 | 42 | 42 | 0 |
| 411 | 40 | 40 | 0 |
| 410 | 40 | 40 | 0 |
| Total | 952 | 961 | +9 |

Plan 429's BWS Woodbridge -> 2967 urgent quantity is 25 pallets and
60,636.8 lb gross, below its 78,000 lb capacity. The enhanced replay keeps it
in one load. The entire plan remains at 54 trucks. The nine additional trucks
in older replays are the explicit tradeoff for preserving the stronger priority
rule. All 178 groups without Ultimate Urgent material reproduce baseline
packing exactly.

## Limits and task corrections

- Initial behavioral RED showed the old implementation failing the new urgency
  packing and display/integration expectations. Some conservation/routing
  scenarios already passed; physical-weight, routing and allocation mutations
  demonstrate their assertions detect real regressions.
- Initial test startup exposed a database readiness race. The wrapper now waits
  for the standard Compose database health check before migrating.
- Initial broad suites used stale deployed harness loaders and shared fixture
  state. Both snapshots now use current loaders and a fresh database per file;
  the baseline was rerun before comparing the enhanced version.
- Historical confirmed/residual quantities required offline normalization.
  The append-only specification clarification records this; live rows are not
  modified.
- The expanded allocation fixture used unsupported `direct` rather than the
  canonical `vendor_direct`. The fixture was corrected; allocation conservation
  assertions were not weakened and runtime normalization was unchanged.
- New lint findings were fixed under green tests, with assertions frozen.
- The first realistic endpoint check needed the captured vendor ID seeded in
  the disposable database to satisfy its existing foreign key. The fixture
  setup was completed; the final endpoint check passes.
- Project-wide unrelated suites are outside this scoped SCM release. Browser
  visual/accessibility checks are not required for a comparator-only change;
  script ordering, assets, VM ordering, and actual HTTP execution are checked.
- Dependency audit/license work is not applicable because the release adds no
  dependencies. No performance budget or supported-version matrix was changed.
- The ten manual mutations use isolated temporary source copies and remove
  them afterward; original source hashes remain unchanged.

## Release and cleanup records

The release directory is `server/deployments/scm-ultimate-packing-20261005/`.
It contains the exact scoped stage, release/rollback Compose overlays, image
build/check logs, and a secret-free manifest with configuration hashes. The
rollback image tag is
`mbbs-operator-app:rollback-scm-ultimate-packing-20261005-v1`.

The baseline and candidate Compose projects were removed with volumes and
orphans. The separate image-verification container was removed. Recorded
`docker ps` and `docker ps -a` contain only the four production containers;
application, database and Ollama health are healthy, and the webhook worker
remains running. Rollback/release images and evidence files are operational
records and are retained.

After explicit production-cutover approval, the prepared action is:

```sh
python3 tools/scm-ultimate-packing-deploy.py apply
```

It rechecks the source and live baseline, verifies preserved environment,
requires idle operator posting, updates only the application, and checks health,
runtime hashes, public assets and unchanged dependency containers. A failed
cutover triggers the retained rollback. The rule applies to subsequent planning
and recalculation; historical saved plans and issued orders are not rewritten
by offline replay.
