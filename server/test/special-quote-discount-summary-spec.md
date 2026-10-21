# Special-order quote discount summary

User request: show the total discount as a positive currency amount and an overall percentage immediately before Subtotal on the quote.

Spec approval: not obtained (autonomous run). The requested feature and existing test-site deployment authorization permit proceeding; this specification records the calculation assumptions for review.

Tier 3 checks apply to the new financial summary. The change presents existing line discounts and does not change pricing or posting.

## Acceptance criteria

1. Draft and saved quotes with 2 PLT at $520 and a 5% discount show `Total Discount (5%)` and `$52.00` immediately above Subtotal. Subtotal remains $988.00, HST $128.44, and Total CAD $1,116.44.
2. The absolute discount is the sum of the actual, individually rounded line discounts. Two $0.03 lines at 50% produce $0.04 savings, $0.02 subtotal, and 66.67% overall savings.
3. The overall percentage is savings divided by the original gross quote amount, including undiscounted materials and ancillary charges, rounded half up to two decimal places. $100 at 10%, $200 at 20%, and $80 of undiscounted pallets produce $50 savings and 13.16% overall savings; subtotal is $330.00.
4. Ancillary charges receive no material discount. Existing saved legacy lines without original prices use their recorded prices; no historic savings are invented.
5. No-discount and zero-value quotes show `Total Discount (0%)` and `$0.00`, with no division by zero.
6. A 100% discounted $100 line shows $100 savings, 100%, and zero subtotal/tax/total. Fractional quantities, six-place rates, and four-place discounts follow existing line rounding.
7. The complete discount/subtotal/tax/total block stays together on one page. Nine short rows with only the first row discounted require a second totals page; discounts do not overlap signatures or footers.
8. Other company quotes that have no special-order discount metadata retain their existing summary. Chinese item text, packing, requester, item alignment, final multipage items, and document access boundaries remain intact.
9. Invalid quantities, rates, percentages, and unsafe aggregate original amounts continue to be rejected; totals never become NaN, Infinity, or negative savings.

## Failure model and checks

| Failure | Verification |
| --- | --- |
| Discount deducted twice or wrong tax | Exact draft/saved totals and financial conservation properties |
| Lost pennies or unweighted percentage | Independently rounded integer oracle and weighted examples |
| Discount applied to pallets or fabricated legacy savings | Ancillary/legacy examples and existing pricing tests |
| Zero division, overflow, malformed inputs | Boundary and hostile-input cases |
| Label or totals missing/clipped on PDF | Actual emitted PDF text, PDFium geometry, and rendered preview |
| Changed ordinary quote layout | Existing ordinary and combined quote tests |
| Unrelated deployment or interrupted order writes | Captured live baseline, scoped image overlay, active-operation gate, rollback, health check |

## Setup and verification

Use existing Node 20 test images, fast-check, c8, ESLint, TypeScript, and PDFium. Add no dependencies, migrations, external financial writes, or commits. Runtime scope is `src/special-stock-documents.js` and `src/field-sales/company-pdf.js`. Persist regression tests, the repeatable verification runner, mutation cases, source hashes, a rendered sample, and evidence. Run the complete affected quote/pricing suite and integration quote lifecycle/combined-document checks in a disposable internal-network database; record any unchanged baseline failures. The whole unrelated application suite is outside this two-file document change.
