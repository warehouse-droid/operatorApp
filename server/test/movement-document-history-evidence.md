# Movement document numbers and driver completion

Operator Personal History and the Sales, Dispatch, and Yard Control In/Outbound
views show locally recorded IR/IF references on their cards and details. Delivery
loads without subsequent completion evidence show `waiting for driver completion`.
Customer pickup and receipt records retain their existing status. The display
does not depend on whether fulfillment posting has finished.

The additional lookup is read-only and batched over records already selected
through the existing operator/yard filters. It uses saved posting evidence and
the exact load IDs retained by automatic fulfillment candidates. New loads do
not inherit prior completion or another load's IF. Verified fulfillment parts
are shown individually. No NetSuite requests or order writes are introduced.

Validation:

- Seven integration tests in `mbt/integration/movement-document-history.test.js`
  use rollback-only fixtures: receipt/pickup references, visibility limits,
  pickup versus drop completion, prior and new loads, completion after the
  selected date, exact fulfillment attribution, transfer loads, and multiple IFs.
- Chromium exercised three records in cards and details across Operator, Sales,
  and Yard Control; tablet and desktop screenshots were inspected. Browser
  evidence is bound to the three client source hashes.
- The existing In/Outbound UI contract and syntax checks passed.
- Read-only live checks confirmed SOB121478 / IF155552, SOM06707 / IF155501,
  and received IR14831. The final pre-release sample retained all 93 outbound
  rows, taking 158 ms versus 169 ms before enrichment; personal history took
  80 ms. These are individual samples, not a benchmark guarantee.

Reproduce with `tools/movement-history-browser.mjs` in the isolated browser
runner, then `python3 tools/movement-history-check.py`. Live checks use
`python3 tools/movement-history-live.py` (explicit read-only transaction);
`--deployed` imports the installed modules. No migrations are required.

Evidence and source hashes: `test-artifacts/movement-document-history/`.
Scoped deployment and service/data checks:
`test-artifacts/movement-history-release-20260927/`.
