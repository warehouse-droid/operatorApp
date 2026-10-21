The Pieces per sales UOM control and review text are removed. New issued-order adjustments always use conversion 1. UOM changes submit without a conversion input, and client-supplied conversion values cannot change quantities or rates. The existing SCM approval workflow applies the entered quantity directly while preserving the original rate and purchase unit cost.

[User correction and executable specification](special-uom-one-spec.md). Tier 3 follow-up; spec approval: not obtained (autonomous run). The user explicitly authorized removing this field and fixing its value at 1.

| Verification | Measured result |
| --- | --- |
| Targeted unit, Chromium and real PostgreSQL/HTTP cases | 53/53 passed; 0 failed; 0 skipped |
| Full affected Special Order suite | 449 tests; 396 passed; 53 failed; 0 skipped |
| Captured-live baseline | 396 tests; 343 passed; 53 failed |
| New regression failures | 0; exact baseline failures retained in baseline.json/tests.json |
| Syntax, differential TypeScript and ESLint | Passed; 0 new diagnostics/findings |
| Changed JavaScript executable lines | 14/14 executed |
| Changed branches | 14/16 executed; remaining defaults recorded |
| Deliberate faults | 3/3 detected; 1 by the generated property alone |
| Explicit reversed file execution | 53/53 passed; 0 skipped |
| Scoped source and supporting-file secret scan | 0 findings; no new dependencies |

The eight selected corrected acceptance cases failed before implementation, retained in red.log. Revised assertions reflect the user's fixed-one policy; tests changed before runtime code. One new test incorrectly assumed PostgreSQL formatted the stored numeric string as 2.000000. It now compares entire saved rows before/after a pending proposal, a stronger check of unchanged data.

Spec 1 is tested by the shared-control unit case, browser adjustment submission without a conversion field, and Sales/SCM review-display assertions. Spec 2 is tested by the UOM-edit HTTP case, missing-conversion/rate-drift case, legacy conversion case, and a property exercising 20 generated quantity/UOM/client-conversion combinations with seed 20261004. The previous 350 field normalization/classification examples also run. Spec 3 is tested by pending/approval/rejection assertions, original-rate/purchase-cost checks, canonical SO/PO rows and existing REST partial-failure/retry cases. Spec 4 is covered by existing authentication/revision/Dispatch/fulfillment/SCM approval cases, complete release-tree/configuration checks and rollback image preservation.

The three deliberate faults honor a client conversion override, restore the blocking conversion prompt, or restore the removed control. Each runs in a disposable copy and must fail a behavior assertion; source hashes confirm restoration. Existing durable review plans retain their recorded snapshots. No production records are rewritten and no migration is required.

Only six runtime files changed over the captured live image. Complete runtime tree SHA-256: `c4c3d60bb93be54c61f9e4dc5ed62da954d2cf678c263aefdd946a2f3825b700`. Only the app was replaced; live configuration and worker/database/Ollama containers were verified unchanged. Live checks confirm application health, three HTTP-served assets, the removed control/review text and anonymous write denial. Verification performed 0 production request writes and 0 NetSuite writes.

Known limits: the broader suite still has 53 pre-existing failures; this is zero new failures, not a globally green repository. The affected Special Order suites were run, rather than every unrelated app test. Type/lint results are differential because baseline errors remain. Branch coverage is reported separately. JavaScript coverage excludes HTML; browser and live asset assertions verify the cache references. External NetSuite behavior is exercised through mocked network boundaries; no live NetSuite writes or performance benchmark was performed. No dependencies, installs, migration or commits were added. Complexity review was manual; the follow-up removes logic and adds one guarded historical-value fallback.

Tool versions: `{"@playwright/test": "1.62.1", "c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "node": "v20.20.2", "typescript": "7.0.2"}`.

Reproduce every verification layer from server with `python3 tools/special-uom-one-verify.py`, using the frozen candidate and the recorded existing isolated runner/database/browser. It never deploys. Regenerate this report with `python3 tools/special-uom-one-evidence.py`; read-only deployment verification is `python3 tools/special-uom-one-deploy.py verify`.

[Measured checks](../test-artifacts/special-uom-one-20261003/checks.json), [coverage detail](../test-artifacts/special-uom-one-20261003/changed-lines.json), [six-file patch](../deployments/special-uom-one-20261003/app.patch), and [deployment result](../deployments/special-uom-one-20261003/result.json).

Deployed at 2026-10-03T20:53:57.489505+00:00; image `sha256:a0615b62cafd38c833a42c76eb9c703a2842d64cd8102ca4b7f5ee0e26a00182`.
