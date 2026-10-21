# Special-order quote before-and-after discount breakdown — evidence (Tier 3)

The special-order quote now displays original item amounts and five ordered summary rows: Subtotal before discount, Total Discount with the overall percentage, Subtotal after discount, HST, and Total CAD. Financial calculations remain unchanged; the renderer no longer mixes original rates with discounted item amounts.

Spec approval: not obtained (autonomous run). The user requested the presentation correction and previously authorized test-site deployment. Both exact-example acceptance tests were observed failing against the captured live renderer before implementation. Existing numerical assertions were retained; only presentation assertions changed to match the clarified request.

The user's draft reconciles as follows: $17,958.00 before discount, $2,437.86 discount (13.58%), $15,520.14 after discount, $2,017.62 HST, and $17,537.76 total. The item Amount column now shows $15,129.00 and $2,829.00. Ontario's standard HST rate and taxation of discounts offered at the time of sale were checked against the [CRA rate guidance](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html) and [CRA registrant guide](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/rc4022/general-information-gst-hst-registrants.html).

Runtime change scope: `src/field-sales/company-pdf.js`. The unchanged `src/special-stock-documents.js` is included in verification and release hashing. Scoped source-tree SHA256: `2b40028164d98e96770cd7cc9d1e4ecd98a79f931dc5672d9a48bdfb477bc257`. The release overlays these verified files onto the captured live image and checks the full source tree for unrelated changes.

Reproduce with `python3 tools/special-quote-breakdown-check.py all`. Reproduce the old baseline with `python3 tools/special-quote-breakdown-check.py baseline`; the baseline includes captured sources and the two previous presentation test files. Artifacts, source hashes, tool versions, and logs are retained under `test-artifacts/special-quote-breakdown`. The release patch is `test/special-quote-breakdown.changes.patch`.

| Behavior | Verification | Result |
| --- | --- | --- |
| Exact supplied draft and saved quote | Two acceptance tests checking original item amounts, preserved financial values, and ordered summary rows | Pass |
| Discounts deducted once; gross minus savings equals net | Existing integer conservation property (250 cases) and emitted-PDF property (8 cases) | Pass |
| Mixed discounts, ancillary charges, penny rounding, zero/full discounts, legacy prices | Existing financial assertions unchanged | Pass |
| Five totals rows stay together above the footer | Boundary PDF test and PDFium geometry | Pass |
| Original item amounts align with the Item column | User draft/saved and Chinese packing sample PDFium checks; user preview visually inspected | Pass |
| Ordinary and combined quotes, requester attribution, packing, access controls, quote lifecycle | Complete affected existing suite | Pass |

| Final fresh verification | Result |
| --- | --- |
| Captured live baseline | 82 passed, 0 failed |
| Complete affected suite | 84 passed, 0 failed |
| JavaScript syntax | All scoped source and acceptance files passed |
| Lint | 0 new diagnostics; 17 pre-existing diagnostics retained |
| Type checking | 0 new diagnostics; 696 pre-existing diagnostics retained |
| Changed executable lines and branches | 6/6 lines and 3/3 branches covered |
| Deliberate presentation mutations | 3/3 caught by acceptance tests and 3/3 by properties alone |
| Suite health | Reordered affected suite passed with seed 20260930 |
| Actual rendering | Five PDFs passed PDFium geometry; user draft preview inspected |
| Dependencies and runtime capabilities | Package manifest unchanged; no new dependencies or runtime I/O capabilities |

Mutations display discounted item amounts, use the net value as the before-discount subtotal, or deduct the discount twice from the displayed net subtotal. They run in disposable copies; the restored acceptance suite passed afterward. Financial snapshots still store net line amounts for calculations, and quotes without special-order discount metadata retain their existing summary.

Skipped layers: unrelated application tests, dependency audit/license checks (no dependency changes), and transaction/race/migration tests (in-memory PDF rendering only). Existing type/lint diagnostics prevent claiming a clean project-wide static baseline. The isolated test database receives migrations for test setup only; deployment performs no schema migration or order/print queue writes.

Scoped live deployment passed at `2026-09-30T06:29:20.950652+00:00` with image `mbbs-operator-app:special-quote-breakdown-20260930` (`sha256:61a4a18b02f32c9b0b0f144d1ff3c43a8bcb0dc707376fa975b32525ce589189`). The active-operation gate passed, application configuration was preserved, and dependencies were unchanged. Public health and live PDF geometry passed; the live rendering of the user's example confirms net $15,520.14, HST $2,017.62, and total $17,537.76. Evidence is recorded under `deployments/special-quote-breakdown-20260930/result.json` and `live-check.json`; `live-quote.pdf` is the independently rendered synthetic example. No rollback was required.
