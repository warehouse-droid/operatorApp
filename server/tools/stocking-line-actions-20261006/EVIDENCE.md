Stocking line actions — evidence, 6 October 2026 (Tier 3)

The app and webhook worker are deployed. Stocking Purchase materials have their own Add to PO/TO proposal, Reject, Reply and Resolve controls. Stocking Transfer materials have their own Reject, Reply and Resolve controls; the existing TO conversion remains available. Actions preserve other materials' decisions and conversations, and the request stays active while work remains.

STREQ-000082 is active at revision 3. Only BWS-HUNT70S-RDM-SM retains POB03992 and ETA 2026-10-08. BWS-HUNT70S-RDM-CG, UNI-WIN70S-RDM-CG and UNI-WIN60S-1530-SAFARI are submitted/pending with no resolution.

Spec approval: **not obtained (autonomous run)**. The [append-only specification](SPEC.md) records the user requirements, failure model, implementation clarifications and worker packaging correction. The old-coder workflow was applied because this change touches purchasing, permissions and concurrent writes. Confidence is limited by the absence of independent specification approval.

**Specification and failure model verification**

The main files are [unit/property checks](../../test/mbt/unit/stocking-line-actions.test.js), [authenticated HTTP/database checks](../../test/mbt/integration/stocking-line-actions.test.js) and [Chromium checks](../../test/mbt/integration/stocking-line-actions-browser.test.js). The descriptions below identify the named tests in those files.

| Behavior or invariant | Verification | Status |
|---|---|---|
| Every Purchase material owns four controls; no bulk selection silently adds siblings | Unit: every Stocking Purchase material owns its four controls; Chromium: SCM Purchase actions send only the clicked material | pass |
| Transfer controls and Sales replies belong to the selected material | Chromium: Transfer Stocking reply and Resolve controls; Sales can reply only in the instructed material card | pass |
| Instructions, replies, ETA/SO references and waiting markers remain separate | HTTP: SCM and Sales conversation belongs to one material; unit: line reply editor and histories remain separate | pass |
| Customer text is escaped | Unit history/editor checks and Chromium instruction fixture with literal script markup | pass |
| Original requester, role, yard and instruction restrictions remain enforced | Authenticated HTTP conversation and invalid/foreign/missing/stale/unauthorized input checks; existing reply HTTP tests | pass |
| Archived scoped instructions cannot authorize a sibling; old unscoped history remains readable | Unit archived instruction check; HTTP archived line foreign-key check; legacy reply checks | pass |
| Sales edits preserve retained conversations, and deletion cannot transfer reply permission | HTTP: Sales edits preserve existing material conversations and removing a material does not authorize another thread | pass |
| Resolve closes only its target, saves canonical PO/ETA, and closes the case only after all lines finish | HTTP: Resolve closes one material, preserves pending lines and the PO, and closes the case only after the final line | pass |
| Quantities, UOM, PO records, sibling demands and operational data survive mixed actions | HTTP mixed proposal/reply/resolve/rejection check, exact database assertions and existing resolution tests | pass |
| A target's demand or TO blocks Resolve; a sibling commitment does not block an uncommitted target | Unit eligibility, HTTP mixed demand and terminal/executing/sibling-TO checks | pass |
| Legacy, cancelled, Pickup and executing operations remain locked | HTTP Resolve rejects terminal or executing work; existing resolution checks | pass |
| Missing, hostile or foreign line IDs, stale revisions and unauthorized roles cause no writes | HTTP no-write snapshots and strict selector property | pass |
| Closed materials cannot be proposed or replied to; single-line legacy calls remain supported | HTTP closed material/single-line legacy check | pass |
| Concurrent retries resolve once and cannot overwrite the saved PO/ETA | HTTP concurrent resolution retries with same/different target and conflicting PO/ETA | pass |
| Proposal/rejection/waitlist clears only the target waiting marker and preserves other conversations | HTTP mixed outcomes and moving one material to waitlist; waiting-state and immutable-merge properties | pass |
| Allocation reconciliation ignores terminal conversations without prematurely closing remaining demand | HTTP allocation completion check and terminal-waiting mutation | pass |
| Sales notification identifies the resolved material, PO and ETA | HTTP event/notice assertions and Chromium Sales resolution notification check | pass |
| Legacy STREQ-000082 correction preserves target, quantities and history; rollback and retry are safe | HTTP legacy correction rehearsal; production rollback rehearsal, correction and read-only queue verification | pass |
| Existing planner may regroup editable proposal IDs but preserves demand identity, quantities and allocation totals | HTTP mixed outcome assertions; documented specification clarification | pass |
| Served pages load current regular assets and retain the earlier Special Request cache version | Live served-page verification; source/image hashes and HTML cache parameters | pass |

**Validation results**

The reproducible entry point, from the repository root, is:

```sh
python3 server/tools/stocking-line-actions-20261006/run.py all
```

The final runtime and test source passed a fresh affected-suite run through `run.py candidate`. The subsequent final `run.py audit` reran focused checks, coverage, types, lint, syntax, mutations, properties and reversed order after deployment-tool packaging changes. It reused the unchanged-source broad baseline/candidate logs. This is not a claim that the broad suite was rerun after every reporting or deployment-tool edit.

| Layer | Actual result and evidence |
|---|---|
| Focused tests | 47 passed, 0 failed, 0 skipped: 23 new core checks and 24 retained reply/resolution checks; `focused-final.log` |
| Affected existing suite | Baseline and candidate each: 466 tests, 449 passed, 17 failed, 0 skipped. Zero new failures; names recorded verbatim in `summary.json`. Candidate duration 210601.802312 ms. Focused legacy checks overlap this suite. |
| Static types | Baseline 11055 diagnostic occurrences; candidate 11013; zero new. Raw compiler exits remain nonzero due to inherited diagnostics. Original declarations are used for baseline; spelling hints are normalized without dropping missing-property diagnostics or occurrence counts. |
| Lint | 28 files; baseline 3 diagnostics, candidate 3; zero new diagnostics. No clean-lint claim. |
| Syntax | All 16 runtime JavaScript files passed Node syntax checks; Python runner/deployment scripts parsed successfully. |
| Changed executable lines | 206/206 executed. A separate fresh-capture verifier confirmed all lines against current source hashes, current c8 JSON and 10 browser captures from the final run. |
| Annotation accounting | 9 AST-identical annotation lines excluded and listed in `summary.json`. The annotation checker proves a changed comparator and new statement remain counted. Source-position fields are removed before comparing ASTs. |
| Manual mutation | 12/12 plausible bugs killed by behavioral assertion failures. Mutants and restoration are persisted in `check.mjs`; temporary copies leave application source unchanged. |
| Property testing | 3 properties, 200 generated examples each, seeds 202610061, 202610062 and 202610063. All passed. All 3 applicable pure-state mutants were also killed by the property suite alone. |
| Order sensitivity | Reversed focused file order: 47 passed, 0 failed, 0 skipped. This is a reversed-order check, not randomized scheduling. |
| Real execution | Actual authenticated Express/Postgres and headless Chromium runs; read-only production request, queue and served-page checks; deployed worker module/database probe. Browser mocks stop at the API boundary. |
| Worker image packaging | The initial image reproduced its missing-module failure without host source mounts. The corrected image passed the same isolated import probe before publishing. Both probes used bounded disposable containers with no network or database. |
| Secrets/dependencies | Final scoped secret scan passed. No package or lockfile changes were introduced by this task; the recorded lock hash is unchanged. |

Results and per-file source hashes are in [summary.json](../../test-artifacts/stocking-line-actions-20261006/summary.json). Fresh coverage inputs and hashes are recorded in [fresh-coverage.json](../../test-artifacts/stocking-line-actions-20261006/fresh-coverage.json). The [purchase screenshot](../../test-artifacts/stocking-line-actions-20261006/browser/purchase-lines.png) shows independent rejected, proposed, pending and resolved materials.

Tool versions are recorded in [toolchain.json](../../test-artifacts/stocking-line-actions-20261006/toolchain.json): Node 20.20.2, Python 3.14.4, Playwright 1.62.1, c8 12.0.0, TypeScript 7.0.2, ESLint 10.8.0, fast-check 4.9.0 and espree 11.2.0. The cached test image is `sha256:e0051d1aa1c279a31eaf8c958301fd9ee80e5be77564883b1c3c346983272fd9`.

The source identity is `8f9eda0e9b0f00b83e557f36cc6af4b982b5d0aa6008ab93e371f020a6c3c678`, computed by [record-source-state.py](../../test-artifacts/stocking-line-actions-20261006/record-source-state.py). [source-state.json](../../test-artifacts/stocking-line-actions-20261006/source-state.json) contains each task file hash and the base commit `a4b73e073c9217bc8629abea296ab8784cc2cd43`. The shared worktree had unrelated modifications; no commit, reset or broad publication was performed.

**Live release and correction**

App image: `sha256:34e30b4d4f7235ec6327122541b58bbd448d333156be7864a24d2abddefdea92`. Worker image: `sha256:da589f1e49f68ad33a49f784c622a4cb25b75533f01f35159213a4e2e5c60064`. Only the task's 18 app files and four worker files were overlaid on their existing production images. Source hashes, environment/configuration hashes and dependency-service preservation checks passed. Active order operations and webhook leases were checked before replacement. Both services are healthy; database and Ollama containers were preserved.

The first worker release rolled back when module verification found its older image lacked `regular-stock-domain.js`. The corrected overlay adds that unchanged tested module and its `regular-stock-input.js` dependency, and verifies the worker's existing `stock-request-domain.js` against the test manifest. The failed release, rollback log and isolated RED evidence are retained.

The production correction was rehearsed with rollback and snapshot equality, then applied with request/line locks, expected revision and exact legacy-state/commitment guards. The target's entire raw line row is unchanged, including its original resolver and timestamp. Other three lines became pending. Request revision advanced from 2 to 3, original events remain intact, and scoped corrective event 503 points to original event 500. Purchase orders were not updated. Operational before/after snapshots and correction results remain outside test cleanup at `/home/ubuntu/operatorapp-investigations/stocking-line-actions-20261006/correction/`.

Read-only verification confirms the request appears in Request and is absent from Closed. [queue-verification.json](../../test-artifacts/stocking-line-actions-20261006/queue-verification.json) records one resolved and three pending materials. Deployment and correction commands are persisted in `deploy.py`, `deploy-worker.py` and `correct-000082.py`; their `verify` modes are read-only. The correction's apply mode is for the captured guarded legacy state, not a general request repair.

**Cleanup and limits**

Every isolated test run registers teardown before startup and uses the standard bounded Compose configuration under `mbbs-tests.slice`. Test limits, init, disposable labels and tmpfs budgets are recorded in the artifacts. Compose teardown removes volumes and orphans; manual worker probes use `--rm` plus registered exact-container teardown.

[cleanup-final.json](../../test-artifacts/stocking-line-actions-20261006/cleanup-final.json) verifies both `docker ps` and `docker ps -a` contain only the four production containers, no disposable tests remain, and task networks/volumes are removed. Production and rollback storage is retained. Earlier task browser artifacts were restored; this run's versions remain under `legacy-current-browser-artifacts`.

The inherited 17 affected-suite failures and existing type/lint diagnostics remain. The full unrelated application suite, cross-version matrix, dependency audit, license audit and performance benchmarking were not run: dependency/schema changes and a new latency budget were absent. No live NetSuite purchasing transaction was posted during validation. Raw c8 branch maps and Chromium ranges are retained; no complete branch-coverage claim is made. Critical races, permissions, hostile input and immutable-resolution behavior are exercised by the explicit tests above.

Genuine RED runs reproduced wrong-line controls, lost conversation state, archived-instruction permission, terminal waiting state, resolver guards and waitlist clearing. An initial waitlist fixture failed a database NOT-NULL constraint; it is retained as a fixture failure, not credited as a behavior failure or mutation kill. Coverage initially misclassified moved JSDoc casts because source offsets remained in the AST comparison; the checker was corrected and its own positive/negative assertions passed. Intentional legacy test contract changes are documented in the specification and originals are archived; operational assertions were retained.
