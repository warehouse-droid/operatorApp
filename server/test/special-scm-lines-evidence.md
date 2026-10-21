SCM material descriptions use normal body text. The desktop stock-check form places Quantity, Sales UOM, PLT, LYR, SEC and PCS together; phone controls wrap without overflow. Required-date corrections persist from SCM stock checks and appear for Sales. Sales retains its editable required date in the case editor and issued-order adjustment. New lines default to today plus 14 calendar days in Toronto, preserving manually chosen dates.

[Specification](special-scm-lines-spec.md). Scoped Tier 2 follow-up with explicit role, transaction and order-lock regression checks. Spec approval: not obtained (autonomous run).

| Verification | Result |
| --- | --- |
| Targeted unit, HTTP/PostgreSQL and real Chromium checks | 61/61 passed; 0 failures |
| Existing affected baseline | 396 tests; 343 passed; 53 pre-existing failures |
| Complete affected suites | 457 tests; 404 passed; 53 failed; zero new failures |
| Syntax, TypeScript and ESLint | Passed; zero new diagnostics |
| Changed executable JavaScript lines | 25/25 executed |
| Deliberate faults | 4/4 detected |
| Reversed targeted test-file order | 61/61 passed |
| Scoped diff and support-file secret scan | Zero findings; dependencies unchanged |

The date unit/property case checks 300 calendar dates plus leap-day, year-end and DST-season examples. A frozen browser clock near UTC/Toronto midnight verifies the business timezone. Real HTTP tests verify persistence, Sales reload, audit details, invalid/past/hostile dates, full batch rollback, role denial and the issued-order lock. Existing suites check Sales layouts, field preservation, financial protection and order adjustments. Browser geometry and screenshots verify desktop and phone layouts. The four deliberate faults change 14 days to 13, omit SCM required-date persistence, restore small description text, or wrap the desktop packing row; each is detected by a named behavior test in a disposable copy.

Eight behavioral failures were observed before implementation (red.log). The first broad baseline attempt ran before its captured baseline files were staged, producing setup/import failures; final baseline and affected results use the captured live source. No assertions were weakened. Runtime files were frozen before final verification. No database migration, new dependency, public network capability or production business write was introduced.

Limits: affected Special Order suites were run, not every unrelated application test. Recorded pre-existing failures remain. Type/lint checks are differential. JavaScript changed-line coverage excludes HTML/CSS, which have browser behavior checks; branch details are recorded without claiming complete coverage. Browser fixtures mock network responses; HTTP tests use real isolated PostgreSQL. Existing tests cover protected financial behavior, but no live NetSuite update was performed. Supply-chain/license audit was skipped because dependencies did not change. Complexity was reviewed manually; the new calendar helper is small and the common renderer owns each field once. No git staging or commits.

Exact runtime tree SHA-256: `499f568a7531b9472d8a6451a53e6d8e05bffeeecf8a51415e9f522aa328290c`. Only seven app files differ from the captured live image. The database, worker, Ollama and app configuration are preserved, and the release retains the previous image for rollback.

Reproduce every check with `python3 tools/special-scm-lines-verify.py`. Tool versions: `{"@playwright/test": "1.62.1", "c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "node": "v20.20.2", "typescript": "7.0.2"}`. Regenerate this report with `python3 tools/special-scm-lines-evidence.py`. Read-only live verification is `python3 tools/special-scm-lines-deploy.py verify`.

[Checks](../test-artifacts/special-scm-lines-20261003/checks.json), [release patch](../deployments/special-scm-lines-20261003/app.patch), [desktop preview](../test-artifacts/special-scm-lines-20261003/browser/scm-desktop-layout.png), [phone preview](../test-artifacts/special-scm-lines-20261003/browser/scm-phone-layout.png).

Deployed at 2026-10-03T21:38:29.840338+00:00; app health healthy; image `sha256:63c82749646b160c605a97da3d4d16dbe6f12b2475a2e3d8c3dec4e31ce10192`. Live assets and anonymous write denial verified. Production request writes: 0; NetSuite writes: 0.
