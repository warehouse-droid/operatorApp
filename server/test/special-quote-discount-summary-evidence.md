# Special-order quote discount summary — evidence (Tier 3)

The quote now shows the positive total discount and its overall percentage immediately before Subtotal. Original line prices, individually rounded discounts, net subtotal, and tax reconcile without deducting the discount again.

Spec approval: not obtained (autonomous run); the request authorized implementation and the session already authorized deployment to the test site. The percentage assumption was stated during work. This evidence does not substitute for independent review of the specification.

Runtime scope: `src/special-stock-documents.js` and `src/field-sales/company-pdf.js`.
Scoped source-tree SHA256: `d0d9b64a40db36811581152843f9f05dc56d2af5303f813844c6206046c54919`. The working tree contains unrelated changes; the release is built from the captured live image with only these two files overlaid.

Reproduce the final verification with `python3 tools/special-quote-discount-summary-check.py all`. The original sources and baseline records are retained under `test-artifacts/special-quote-discount-summary/before` and `baseline-tests.json`; `python3 tools/special-quote-discount-summary-check.py baseline` reproduces the baseline using those captured sources. Tool versions and source hashes are recorded in `checks.json`.

| Specification behavior | Verification | Result |
| --- | --- | --- |
| Positive savings and percentage before Subtotal, draft/saved totals preserved | New draft/saved PDF tests and PDFium review | Pass |
| Weighted percentage, undiscounted pallets included in gross, no discount on pallets | Mixed-percentage example and conservation property | Pass |
| Individually rounded cents, fractional quantity | Rounded-pennies and zero/full/fractional examples | Pass |
| No discount, zero gross, 100% discount | Zero/full discount examples | Pass |
| Legacy recorded net prices | Legacy saved-price example | Pass |
| Totals stay together at a page boundary | Boundary PDF test and rendered second page | Pass |
| Ordinary/combined company PDFs, Chinese, packing, requester, access boundaries | Existing quote/document suite | Pass |
| Malformed percentages and unsafe gross amounts rejected | Hostile and overflow cases | Pass |

| Final fresh verification | Result |
| --- | --- |
| Existing quote/pricing baseline | 72 passed, 0 failed |
| Complete affected quote/pricing and integration suite | 82 passed, 0 failed |
| JavaScript syntax | All scoped source and test files passed |
| Lint | 0 new diagnostics; 17 pre-existing diagnostics retained |
| JavaScript type checking | 0 new diagnostics; 696 pre-existing diagnostics retained |
| Changed executable lines | 19/19 covered |
| Changed branches | 8/8 covered |
| Financial mutation tests | 3/3 caught by the acceptance suite, and 3/3 caught by properties alone |
| New properties | 250 integer conservation cases and 8 emitted-PDF cases, fixed seeds |
| Suite health | Reordered full affected suite passed; seed 20260930 |
| Actual document rendering | Draft, saved, and boundary PDFs passed PDFium geometry checks; preview inspected |
| Dependencies and runtime capabilities | Package manifest unchanged; no new dependencies or runtime network/filesystem/environment capabilities |

The financial mutants replace savings with the net amount, calculate percentage against the net amount, and deduct the discount twice. All mutations occurred in disposable copies; restoration was verified with the acceptance suite.

Skipped layers: the unrelated application suite is outside this two-file document change; supply-chain audit and license checks are not applicable because no dependencies changed. Race/migration/write-rollback tests are not applicable to this in-memory PDF calculation; deployment retains the existing active-operation gate and automatic app-image rollback. Legacy type/lint diagnostics prevent claiming a clean project-wide static baseline.

Honest notes: all 10 new acceptance tests were observed failing against the original renderer. An initial style check detected increased builder complexity and a shadowed variable in the verification harness; the calculation was extracted into a small helper and the harness variable renamed with all assertions unchanged. The installed TypeScript version returns diagnostic exit code 1; the harness was corrected to compare those diagnostics to the captured baseline. The final complete run passed after these corrections.

Live deployment results and its independently rendered synthetic quote are recorded under `deployments/special-quote-discount-summary-20260930/result.json` and `live-check.json`. Live verification performs no order, database, or print queue writes.
