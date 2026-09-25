# Quote memo verification — 2026-09-19

The quote editor now has one optional Memo below the quote total. Item-level price reasons are removed, and manually entered rates can be saved without a reason. Existing quote notes use the same stored property and remain available in drafts, revisions, PDFs and NetSuite posting payloads.

Spec: [quote memo acceptance criteria](../test/field-sales-quote-memo-spec.md). Spec approval: not obtained (autonomous run); the user authorized the behavior and deployment, but did not independently review this test specification. This limits confidence to the expressed and tested criteria.

Reproduce from the repository root with `sudo -n bash server/tools/field-sales-quote-memo-test.sh`. The entry point uses the retained `field-sales-check-2941306` tool image and disposable PostgreSQL 18 containers. It records the source hash before testing and rejects changes during the run. No credentials or live transactions are needed.

Final source SHA-256: `9dcd1b6907071a8d461393e00d790532b6515ec41129aff2ce3fb31a7d12162e`.

Tool versions: Node 20.20.2, Playwright 1.62.1, c8 12.0.0, ESLint 10.8.0, fast-check 4.9.0, TypeScript 7.0.2. No dependencies were added.

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| One memo below the total; no item reason fields; add-item position and subtotals preserved | Trade browser: desktop/phone layout, position, field-count and amount assertions | Pass |
| Entered rates save with empty memo/reasons while invalid prices, tax and revision checks remain | Q9, T5, money properties and original browser tax conflict | Pass |
| Missing catalog price accepts an explicit rate, with immutable catalog provenance | T5 and trade browser blank-price checks | Pass |
| Memo typing, item changes, save/reopen and read-only historical view | Trade browser | Pass |
| Offline memo/reload and entered rates survive catalog changes | Original browser | Pass |
| Memo serialization, limits and historical text | M1 property: 30 generated examples, seed 20260919; M2 | Pass |
| PDF notes and posting payload memos | Existing PDF2, M2 and browser PDF download | Pass |
| Memo text cannot break out of the textarea | Browser saves/reopens `</textarea><img ...>` text and asserts no injected image | Pass |
| Auth, financial totals and publication gates | Full Field Sales suite, including existing exact-money/role properties | Pass |

Final fresh verification:

- 94 Field Sales tests passed; 0 failed or skipped.
- 11 browser scenarios passed; no page errors.
- ESLint and strict shared domain/pricing type checks passed.
- 6/6 measured changed executable JavaScript lines covered: 5 UI lines and 1 server import line. The server behavior change removes a validation branch; explicit save tests and a mutant test cover that removal.
- Server/shared coverage: 994/994 lines, 104/104 functions, 976/1036 branches (94.2%). These totals are diagnostic; they do not imply all UI branches are covered.
- 4/4 manual mutants killed: restoring the reason requirement, dropping the memo, replacing the entered rate, and detaching the memo from the form. The database property independently killed all three applicable server mutants; the form mutant is covered by a real browser.
- All 25 Field Sales test files passed again in randomized order, seed 20260919.
- Complexity review: no new runtime functions or decision branches; the server override validation branch was removed. The existing browser renderer remains a large template; this task does not refactor it.
- Capability review: no new runtime network, subprocess, filesystem or environment access; no dependency/configuration/schema changes or production transaction tests.

Limits: TypeScript checks cover the existing checked domain/pricing modules, not the untyped quote renderer. CSS and the service-worker cache version are verified through browser execution, visual inspection and deployment asset hashes rather than JavaScript changed-line coverage. NetSuite propagation uses existing payload and RESTlet contracts; no live estimate was created. Unrelated application suites were not rerun.

Failures encountered: before implementation, Q9/T5/M1/M2 rejected entered prices without a reason and the browser could not find Memo. A missing `rg` in the privileged test shell initially caused incorrect test discovery; that disposable runner was stopped, and file discovery now has a fallback. Two browser assertions queried the database before the asynchronous save was acknowledged; they now poll for the saved revision and retain all value assertions. The final fresh run passed after those test timing corrections.

Machine-readable evidence is in `server/test-artifacts/field-sales/quote-memo/checks.json`. Release scope and live verification are recorded by `field-sales-quote-memo-deploy.py` under `server/test-artifacts/field-sales/quote-memo-deployment-20260919/`.

Deployed at 2026-09-19 03:01:17 UTC as `mbbs-operator-app:field-sales-quote-memo-20260919-v1`, image `sha256:e079562ddfd309c701e2aba74a71ce1bdc131fbc50fa474e62e71721757dc0b7`. All four runtime hashes and 12 live health/asset/auth checks passed; configuration and other service containers were preserved.
