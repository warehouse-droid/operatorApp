Special Order field editing is deployed. Sales case editing includes all New Request line fields. SCM stock checks include product name, colour, size, Detail Spec, quantity, UOM and PLT/LYR/SEC/PCS. Sales can propose the same corrections after SO creation, including discount, required date and line note; SCM approval still precedes order updates. The original selling rate stays fixed after issuance, and a UOM change requires an explicit pieces-per-sales-unit conversion.

[Specification and failure model](special-case-fields-spec.md). Tier 3; spec approval: not obtained (autonomous run). This records tested behavior, with no independent approval of the written specification.

Measured checks on the exact release source:

| Check | Result |
| --- | --- |
| Targeted unit, HTTP/PostgreSQL and Chromium checks | 49/49 passed; 0 failed; 0 skipped |
| Existing and targeted affected suites | 445 tests; 392 passed; 53 failed; 0 skipped |
| Captured live baseline | 396 tests; 343 passed; 53 failed |
| New failures versus baseline | 0; exact existing failures are retained in baseline.json and tests.json |
| Syntax, differential TypeScript and ESLint | Passed; 0 new type errors or lint findings |
| Changed JavaScript executable lines | 258/258 executed |
| Changed branches | 266/293 executed; remaining branch/default locations recorded |
| Deliberate faults | 6/6 detected; 3 detected by properties alone |
| Explicit reversed test-file order | 49/49 passed; 0 skipped |
| Generated properties | 350 examples; seeds 20261003 and 202610031 |
| Scoped source/added-file secret scan | 0 findings; no dependencies changed |

Acceptance criteria and evidence:

| Spec | Executable evidence |
| --- | --- |
| 1: field parity, retained values, phone layout, cancel/conflict/no-op | special-case-fields-browser.test.js and existing special-case-edits-browser.test.js |
| 2: material reset, untouched rows, audit and draft invalidation | Sales all-fields HTTP case; field classification properties; existing case-edits reset/private-audit checks |
| 3: discount/note preserve reviews and purchase costs | Discount/note HTTP case; existing legacy embedded-discount and converted-rate cases |
| 4–5: omitted fields, legacy values, bounded/hostile values and rollback | Field normalization unit cases, 350 property examples and invalid SCM batch rollback |
| 6: authentication, scope, revision, concurrency, order locks and migration | Existing case-edits HTTP authorization, races and SQL failure cases; new migration scope/repeat/rollback case |
| 7: real forms, persistence and quote basis | Chromium phone/desktop cases, real isolated HTTP/PostgreSQL and quote snapshot checks |
| 8–9: SCM corrections, protected sales fields and atomic response | SCM browser batch; SCM database corrections/injection/rollback cases |
| 10: pending/rejected/approved metadata | Issued-review HTTP cases and Sales/SCM pending-review browser checks, including escaped text |
| 11: SO/PO descriptions, packing, conversion and Dispatch rows | Real quantity-service/REST adapter fixtures and canonical SO/PO database assertions |
| 12: drift, partial failure, retries and compatibility | REST correction/retry/drift cases and existing adjustment/recovery suites |

The initial red runs are preserved in red.log, red-orders.log and red-browser.log. Later assertions caught missing saved-order packing and loss of multiline details/notes; those failures are retained. Original browser regression assertions also caught a changed composer layout, missing note history and an incompatible adjustment payload. These were corrected without weakening assertions or increasing timeouts. Added pending-review assertions are verified against a deliberate fault that removes reviewed fields. One coverage-tool format error and one secret-scanner false positive in the runner's environment argument construction were corrected before the final checks.

The six faults drop corrections, skip material review, ignore discounts, omit remote packing, omit service corrections, or hide proposed fields from the review. Each runs in a disposable source copy; hashes confirm restoration. Complexity was reviewed manually: shared field normalization/rendering/persistence helpers avoid repeating field lists and validation in the three workflows. No new runtime network, subprocess, filesystem or credential capability was introduced.

Only the 12 listed runtime/migration files differ from the captured live image. Complete runtime tree SHA-256: `9433caab0b6c5a92edd823de38a305e342bc1c0e1299b134a2aff8b4e10fb48d`. The release records every file hash, preserves the live configuration and worker/database/Ollama containers, and retains the previous image plus trigger definition for rollback. Migration 264 changes the scoped price-protection function and rewrites no request rows. Live verification confirms application health, deployed files, field rendering and anonymous write denial. Verification made 0 production request writes and 0 NetSuite writes.

Known limits: the affected Special Order suites were run, rather than every unrelated application test. The 53 pre-existing failures remain; this is not a globally green repository. Type/lint checks are differential because existing diagnostics remain. Branch coverage is reported, not complete. JavaScript line coverage excludes HTML and PL/pgSQL; browser and migration behavior assertions cover those changes. Browser fixtures mock network responses, while repository/HTTP checks use real isolated PostgreSQL and REST tests mock only the external NetSuite boundary. No live NetSuite modification or production-scale performance benchmark was performed. Dependency/license audit was not repeated because package files are unchanged. No checkpoint commits were made.

Tool versions: `{"@playwright/test": "1.62.1", "c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "node": "v20.20.2", "typescript": "7.0.2"}`.

Reproduce all verification from server with `python3 tools/special-case-fields-verify.py`. It uses the frozen candidate, captured baseline, recorded installed tools and existing isolated runner/database; it never publishes. Regenerate this report with `python3 tools/special-case-fields-evidence.py`. Read-only release re-verification is `python3 tools/special-case-fields-deploy.py verify`.

[Machine-readable checks](../test-artifacts/special-case-fields-20261003/checks.json), [coverage detail](../test-artifacts/special-case-fields-20261003/changed-lines.json), [scoped release patch](../deployments/special-case-fields-20261003/app.patch), and [deployment result](../deployments/special-case-fields-20261003/result.json).

Deployed at 2026-10-03T20:33:46.309583+00:00; image `sha256:b2f4d6aae5dce59d628221e4ae399164d0322fea1aa20a853bce92cd3051b959`.
