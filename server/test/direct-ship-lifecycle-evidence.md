# Direct shipment lifecycle evidence

Spec approval: **not obtained (autonomous run)**. The user authorized fixing and replaying direct-ship SOs with linked TOs/POs. This is Tier 3 validation of the [executable specification](direct-ship-lifecycle-spec.md), not independent review of its completeness.

Runtime source hash: `96357ba54780ef6e0087c36f8eaf47893ab8a5d8c5e5736739bb2a8823b5291a`. Candidate image: `sha256:1e77818e8f912c6802e4548641943867e3e6c20f1b9051a6c82dfc5b3f763baf`. The 14 runtime differences from the previous production release are recorded in `tools/direct-ship-files.json`. The release was rebased onto the separately deployed Special Stock fix, which is preserved unchanged.

## Acceptance evidence

| Behavior | Executable evidence |
| --- | --- |
| Fully linked PO cannot be planned twice; both references guarded; SCM inherits linked planning | `direct-ship-po-planning.test.js`: feed, actual V2 rejection, common guards, schedule |
| Partial PO requires all SO deliveries and its remaining delivery, in either order | Same integration file: both delivery orders, actual latest timestamp, both completed aliases blocked |
| Partial TO exposes exactly its unallocated cargo through feed, saved plan and Driver | `direct-ship-to-lifecycle.test.js`: 20 native pieces minus 19 leaves 1; real replacement command, compact snapshot and materialized Driver job |
| TO completion waits for both portions; full TO uses actual Driver time | Same integration file: both delivery orders, completion and direct receipt timestamps |
| Quantity conservation and source caps | `direct-ship-quantities.test.js`: 1,000 generated cases, seed 35925230; duplicate item lines, cancellation, mixed units; integration tests for reduced source and already-received stock |
| Replay and concurrency do not double receipts | Competing transactions, replay assertions and existing online/offline Driver integration; 25-way completion race |
| Correct historical projection without deleting evidence | Migration integration: immutable old event retained, correction applied twice, legitimate later completion remains effective |
| Started route cargo stays unchanged | `direct-ship-recorded-projection.test.js` |
| Browser displays exact remaining pickup/drop quantities | `frontend/direct-ship-quantities.test.js` executes the production declarations with stale stop totals |
| Cached planner cards reflect repaired history | Fresh production-copy replay rebuilds the derived catalog and verifies corrected labels without changing delivery/receipt totals |

## Final verification

- Full isolated suite: 3274 tests, 3247 passed, 26 pre-existing failures, 1 skipped. All failing files replayed on the production baseline; **zero new failures**.
- Related suite: 125 tests, 124 passed, 1 pre-existing harness failure. Randomized order (seed 23035925) produces the same result. The 23 new direct-shipping tests pass.
- Actual offline Driver flow: 3 passed, 0 failed. Online flow is included in the related suite.
- Changed backend JavaScript lines: **166/166 covered**, across 11 modules. New TO projection line coverage: 100%; branch coverage: 86.27%. SQL migration paths and browser behavior are tested directly; they are not included in the Node line metric.
- Manual mutations: **11/11 killed**; the quantity suite alone kills its 5 applicable mutants (four generated-property defects plus the fixed mixed-unit example).
- Syntax, lint and types: zero new diagnostics. Existing lint diagnostics: 609; existing type diagnostics: 282.
- Secret scan: task diff passed. A whole-file scan initially flagged an unchanged HTML token attribute; changed-line scanning confirms it was not introduced by this task.
- No packages or runtime network capabilities were added. Existing Node 20.20.2 tooling image `field-sales-check-2941306:latest`, PostgreSQL 18 and project lockfile dependencies were used. New functions are bounded to projection, database guards or release tooling; existing broad repositories retain their public signatures.
- Candidate app and worker booted; health returned 200; migrations ran twice. The previous app and worker also booted against the migrated schema. The shared priority scheduler test preserved Operator capacity during worker activity. These smoke checks made no live NetSuite writes.

## Production-copy replay

Snapshot: `test-artifacts/direct-ship-deployment-20260926-v2/postgres-before.dump`. The private dump and per-order data remain under `test-artifacts/`.

83 distinct linked SOs, 34 direct TO links (32 active, 2 cancelled), and 101 PO allocation rows (86 active) were checked. 52 recorded customer drops were replayed twice. 43 isolated delivery simulations passed. Receipt quantities and immutable event counts were unchanged on the second replay. Simulations are not represented as real deliveries. No production Driver jobs, receipts or NetSuite fulfillments were created by replay. The completion-only recovery matched 3 historical entries discovered by actual replay, and a second recovery created nothing.

## Reproduce and limits

Run `bash tools/direct-ship-gauntlet.sh`. It uses the captured baseline, frozen release and private production backup. The production-data portion requires authorized access to that backup; ordinary tests use disposable seeded databases. `tools/direct-ship-test-source.py` copies final task tests/tooling into the frozen runtime without changing runtime files. `validation-files.json` records their hashes. Each layer's raw logs and JSON are retained under `test-artifacts/direct-ship-lifecycle-20260925` and `test-artifacts/dispatch-special-po-lifecycle/checks/direct-ship-*`.

The initial RED runs exposed the duplicate planning and premature TO completion defects. Later RED runs added receipt capping, mixed-unit, recorded-route and alias protections. An unknown-quantity fixture initially violated a schema constraint; its fixture was corrected without changing expectations and its guard behavior was proven by mutation. A timestamp mutant initially broke SQL parameter binding; it was replaced with a valid processing-time defect and the final suite killed it. The read-only migration preview initially undercounted candidates because an inner SQL alias shadowed its correlation; comparison with the actual migration exposed it, and the corrected preview matches the four candidates. No acceptance assertion was weakened.

The full repository is not globally green: the exact baseline failure names are in `release-checks.json`. Coverage is reported for changed backend lines, not as total application coverage. Browser quantity tests execute actual declarations but do not substitute for testing every interactive browser path. Replay covers one recorded production snapshot; it does not send historical business actions again to NetSuite. Migration rollback compatibility was verified by startup, while immutable correction history is retained. These are scoped evidence and explicit limits, not a claim of universal correctness.

## Live deployment

Deployed on 2026-09-26 at 03:15 UTC; final service verification: 2026-09-26T03:37:45.316352+00:00. Both app and worker run the exact verified image, with 1082 runtime file hashes checked in each. Local/public health: 200/200; anonymous protected API access: 401. Database, Ollama and service configuration were preserved.

Four original partial-TO completion events remain immutable and are excluded from the effective history. Three missing PO completions were recovered from their original Driver evidence: LOINC-024857, LOINC-028285 and SN1398328. Receipt counts and received quantities were unchanged by recovery; a subsequent query found zero missing completions. SPREQ-000007 was handled by the other thread, and this recovery left its record unchanged.

Catalog refresh: 71 references, 123 cards written, 0 removed. LOINC-035925 is Completed, both PO aliases are blocked from replanning, and its completion time (2026-09-25T19:25:43.188Z) matches actual Driver evidence. Live checks covered 33 fully linked PO families and 32 active TO links. The live inventory matches all 83 SOs in the replay.

The first live catalog check failed because a NetSuite sync ran during verification. TOB01093, TOB01095 and TOB01135 acquired independent Received reconciliation evidence; TOB01129 became Pending Receipt. The existing fulfilled-TO policy uses a Completed card label while retaining residual planning eligibility. The deployment check had incorrectly equated that label with local Driver completion. The specification now states this distinction explicitly; runtime acceptance tests were unchanged. The clarified checks require no obsolete local completion, retain residual planning eligibility, and verify TOB01129's SCM schedule is In Transit. The isolated snapshot replay was rerun with these checks. The deployed runtime source was unchanged after the full-suite run.

The development image disappeared before the post-deployment replay could start its application checks. That infrastructure attempt failed, and its logs were retained. The replay runner now uses the exact release image ID from the manifest, fails early if it is unavailable, and prohibits pulls. The final isolated replay uses production dependencies and is recorded in `postdeploy-runtime-replay.log`; the final changed-line secret scan is in `postdeploy-secrets.log`. The full gauntlet can rebuild a missing development image using the existing `Dockerfile.test` and lockfile; this rebuild branch was syntax-checked but was not needed for the final runtime replay.

Newer runtime edits from the other thread are outside this deployed snapshot: `src/netsuite.js`, `src/special-stock-native-po-adapter.js`, `src/special-stock-netsuite-adapter.js`, `src/special-stock-request-domain.js`, `src/special-stock-request-repository.js`, `src/special-stock-request-service.js`. Private backups and raw per-order deployment evidence remain under `test-artifacts/direct-ship-deployment-20260926-v2/`.
