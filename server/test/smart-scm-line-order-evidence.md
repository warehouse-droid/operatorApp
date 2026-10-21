# Smart SCM proposal line ordering — validation evidence

Implemented locally on 2026-09-30. SCM can move any material or physical PALLET row in PO/TO proposals and editable Vendor Replies. The saved combined sequence survives reload, vendor confirmation, partial confirmation and Hold splits, and controls the outgoing NetSuite PO/TO items. Synced POs use the current NetSuite line sequence, including PALLET.

Spec approval: not obtained (autonomous run). Tier 3 because the sequence reaches order submission. Acceptance criteria and failure model are in [the executable spec](smart-scm-line-order-spec.md). No dependencies were added, no commits were made, and no production database, running application, or real NetSuite records were changed.

## Reproduce

From the server directory, run:

```sh
bash tools/scm-line-order-check.sh
```

The entry point creates a disposable PostgreSQL database on an isolated Docker network, runs migrations and database tests, removes the database/network, runs Chromium with networking disabled, combines native Node/Chromium coverage, checks the actual task diff, and writes logs under `test-artifacts/scm-line-order/final/`. It requires the existing local images `mbbs-regular-v2:test`, `mbbs-regular-v2:e2e`, and `postgres:18-alpine`.

Recorded tools: Node 20.20.2, fast-check 4.9.0, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, Playwright 1.62.1, Chromium build 1234. No host Node installation is needed.

## Final fresh run

The final entry point completed with exit code 0 at approximately 20:46 UTC, after the last implementation and verification-script edit. Its results are in `final/summary.json`, `final/checks.json`, and the accompanying logs.

| Layer | Result |
| --- | --- |
| Affected unit/property/UI and database lifecycle tests | 133 passed, 0 failed, 0 skipped: 109 unit/property/UI tests plus 24 database/lifecycle tests |
| Suite ordering | The 109 unit/property/UI tests also passed in reverse file order |
| Browser | 8 checks passed; 0 browser errors |
| Property checks | Ordering conservation/idempotence/identity: 200 generated cases, seed 930; existing purchase conservation harness: 175 cases |
| Types | Shared browser/server ordering core and adapter passed `checkJs` with no emit |
| Lint | New ordering code, changed adapters, new tests and validation tools passed with zero warnings |
| Syntax | Six larger changed server/browser files passed Node syntax checks |
| Mutation | 5/5 manual behavior mutants killed; original workspace source remained unchanged |
| Changed-line coverage | 262/262 changed measured JavaScript lines covered across all 13 changed JavaScript files |
| Persistence/concurrency | Actual PostgreSQL reload, exclusive row locking, one successful concurrent writer and one HTTP 409, audit-failure rollback |
| Access and hostile inputs | Actual application endpoint: HTTP 401/403/200/409/400; duplicate, missing, foreign, malformed and excessive keys rejected |
| Migration | Full migration run passed; new migration applied twice; drop/re-add and array constraint rehearsed inside a rolled-back transaction |
| Task-diff secrets scan | No private keys, AWS access keys or OpenAI project keys added |
| Existing baseline failure | One unchanged Blanket UI harness failure remains, documented below |

Coverage is enforced on the task's changed lines against captured starting-file snapshots, preserving the workspace's unrelated edits. Whole-file percentages for the existing large server are not the coverage gate. HTML/CSS are exercised in Chromium; SQL is exercised against PostgreSQL and has no JavaScript coverage count. The real TO execution function is run in a VM with its original source offsets; only its native function coverage is mapped back to `src/server.js`, excluding the synthetic script root. That mapping is recorded in `final/transfer-boundary-coverage.json`.

The feature source state is SHA-256 `25696962de5864301947e8901875d6e5cbf88c8d8a3c72e1f8819b6515cf4ed1`, computed over the names and SHA-256 hashes of all 16 changed production files, including HTML, CSS and migration. Per-file hashes and coverage are in `final/source-coverage.json`; the feature diff and snapshot hashes are in `final/task-diff.json`. Repository HEAD was `3de46cd5953ac57ded6833605060280e355aaa5f`; the workspace already had unrelated uncommitted changes, so the commit alone does not identify this implementation.

Concurrent work added the unrelated `persistPurchaseStockDrafts` helper to the planning repository. The comparison baseline includes that independent addition so its lines are excluded from this feature's coverage gate. The original starting snapshot is retained under `baseline/original/`, and the exact adjustment is recorded in `baseline/parallel-adjustments.json`. The final run used the current repository with both changes present.

The shared workspace continued changing after the final run: independent purchase-stock work modified the planning, vendor and server files again. The 16 production files from the validated state are archived under `final/source-snapshot/`, with every file checked against its recorded hash. The results above attest to that source state and the line-order changes; they do not attest to subsequent independent edits.

## Acceptance mapping

| Spec scenario | Verification |
| --- | --- |
| 1. PALLET third, saved in both views | Unit test `PALLET can be third`; PostgreSQL save/reload test; browser native drag and Vendor Replies reload |
| 2. Drag/keyboard, same load, preserve inputs | Browser checks: native drag, Vendor Replies keyboard, cross-load drop ignored, TO keyboard, live event preserves drafts |
| 3. Quantities/prices/destinations/totals unchanged | Database compares complete material rows before/after, totals and overrides; payload compares all emitted fields/objects |
| 4. Reject invalid/stale/locked updates | Unit permutation validation; database locked/missing/stale cases, concurrent writers and audit rollback; actual authenticated HTTP endpoint |
| 5. Vendor staging, splits, multiple yards, zero PALLET | Database review child/purchase preparation, partial confirmation and held child; unit independent pallet destinations and zero omission |
| 6. TO order reaches submission | Actual repository TO preparation; payload regression; real server TO execution captures the ordered NetSuite request at the network boundary |
| 7. Canonical NetSuite sequence | Unit fixture with out-of-order permanent IDs and persisted sequence metadata; existing created-PO financial/UI tests; browser PALLET third and linked PO locked |
| 8. Surviving/new rows, idempotence | Unit surviving-key test and 200 generated ordering cases |
| 9. Legacy behavior and regressions | PO/TO legacy payload comparisons; all affected SCM/transfer tests; baseline harness tracked separately |
| 10. Additive migration and rollback | Actual migration idempotence, legacy empty array, rejected object shape, transactional drop/re-add rollback |

## Failures found and limits

The initial ordering tests failed before implementation, and the captured original browser renderer had zero drag handles. A later held-child test reproduced PALLET reverting to the end; copying the saved sequence into the held child fixed it. Test harness loaders were extended to include the new shared scripts without weakening existing assertions.

The final run retains this pre-existing failure in `src/smart-scm-blanket-ui-harness.js`: `Smart SCM must load cache-busted asset scm-smart-exclusions.js?v=20260801-po-only-pauses-v1.` It failed before the feature and still fails with the same message. The entry point accepts only that specific known failure in a separate baseline check; it does not count it among the 133 passing tests or change its assertion.

During validation, the shared workspace temporarily lacked the unrelated `regular-stock-purchase-repository.js` imported by another module. The API test failed to start, then passed after that file became available; no unrelated source was changed here. Validation-tool issues were corrected: Playwright's coverage return shape, precise diff hunk alignment, and mounting the migration into the report container. The entire entry point was rerun after those corrections.

Live NetSuite creation was not exercised: the actual TO execution test captures the outgoing request and deliberately fails at the network boundary; PO preparation/payload and canonical PO display use fixtures and the actual repository. No latency budget was specified, so no performance benchmark was added. Type checking covers the shared ordering library; the classic UI is validated through lint, syntax and real Chromium. The unrelated whole-project suite was not run; all affected SCM/transfer unit/property tests and relevant vendor database/UI lifecycle harnesses were run. Broader dependency auditing was not repeated because dependencies were unchanged.

Visual artifacts: `test-artifacts/scm-line-order/proposal-pallet-third.png` and `vendor-netsuite-order.png`. Deployment was subsequently authorized and completed as recorded below.

## Deployment — 2026-09-30

The user requested deployment with a short cutover. The release was built by applying the validated feature patch to the live `special-scm-item-name-20260930-v2` image. It changed exactly the 16 intended files; all 1,158 runtime source/assets/migration files in the resulting image were checked against the captured live tree plus this patch. The independently changing workspace was not copied into the release.

The exact release candidate passed the full entry point again: 133/133 affected tests, 109/109 in reverse order, 8/8 Chromium checks with zero browser errors, 262/262 changed measured lines, 5/5 mutants killed, plus types, lint and syntax checks. The same pre-existing Blanket UI assertion remains isolated and documented above. Candidate checks are in `deployments/scm-line-order-20260930/candidate-checks.json`, with full logs under its `validation/test-artifacts/scm-line-order/final/`. Its feature source hash is `ff600e58449ab9cae34e898a2861c87da713bb56c52432aa691389521bb6febb`.

The release was prepared and published with `python3 tools/scm-line-order-deploy.py capture`, `prepare`, and `apply`. The persisted deployment script captures/gates the live image, validates the candidate in a disposable database/browser, builds before cutover, checks active operations, applies only the authorized migration, preserves the app's configuration, and restores the previous image automatically if verification fails. The app was the only service recreated; the database, webhook worker and Ollama containers retained their identities.

Deployment completed at **22:08:14 UTC** on [Smart SCM](https://test.mbbsoperation.com/scm/smart). The additive migration took **0.158 seconds** while the old app stayed online. Health probing observed an interruption of **8.613 seconds**; the cutover including verification took **11.981 seconds**. All monitored active-operation counts were zero before the switch. Rollback was available and was not needed.

Live checks passed: local/public health returned 200, all seven changed public assets/pages returned 200 and matched the candidate hashes, the migration was recorded once, the JSONB column existed with zero invalid orders, the anonymous reorder request returned 401, and the running app's canonical PO projection placed PALLET third despite out-of-order NetSuite permanent line IDs. No business proposal or NetSuite order was changed by the verification.

Deployed image: `mbbs-operator-app:scm-line-order-20260930`, ID `sha256:224b17a3a8827a3b5359a867a47076c08a20466ae0d34d223c88f05cbfe91044`. The release result, measured cutover, migration timing, full source manifest, and rollback Compose override are retained in `deployments/scm-line-order-20260930/`.
