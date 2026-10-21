# Sales discounts and PALLET adjustments

Spec approval: not obtained (autonomous run). Tier 3: order amounts and recoverable remote writes.

Acceptance criteria:

1. Sales can edit each accepted product's discount (0–100%, at most four decimals), its package quantity, and the whole PALLET quantity (including zero). Original material and pallet rates remain fixed. The manual NetSuite refresh button is absent. SCM sees every proposed before/after value.
2. A submitted adjustment changes no issued value until SCM approves. Rejection retains issued values. Invalid, stale, planned, closed, fulfilled, received, or billed orders cannot be adjusted. Existing authorization and mixed test/live guards remain.
3. New SOs keep the gross converted material rate. Each nonzero discount creates exactly one adjacent Custom Discount% (active item 10716) line with a negative percentage rate; zero omits that line. Discounts do not apply to PALLET or vendor PO prices. Local quote math remains based on the original package rate.
4. Approval changes the original linked SO before the PO. Material quantity changes preserve proportional PO quantity; discount and pallet-only changes leave PO quantities and purchase costs unchanged. PALLET can be added, changed or removed. Existing material line identities and native links survive.
5. The durable plan describes the complete original and target records. Retry accepts only the original or complete target of each order; a lost response or partial SO/PO success cannot duplicate discounts, pallets or orders. Unrelated edits are conflicts. Webhooks arriving during approval accept only authorized transitions, then local values, canonical quantities, and native PDF cache keys reflect the approved result.
6. Legacy net-rate orders remain untouched until an approved price adjustment explicitly converts that material to gross rate plus discount. SPREQ-000006 is never changed or retried. No production order is changed as a test.

Failure model: wrong percent sign/double discount (payload, decimal properties and native-script contract); misplaced discount or duplicate lines (multi-material insertion/removal, retry tests); stale write/racing webhook (complete baseline checks and DB transition tests); partial writes (saved plan and timeout recovery); accidental PO cost changes (unchanged-line assertions); unsafe dispatch changes (planning/execution guards); cached old PDFs (snapshot assertions).

Setup: existing Node test runner, isolated PostgreSQL/Docker review environment, Playwright, ESLint, TypeScript, c8 and fast-check. No new dependency, git commit, or live business-data test. Preserve prior dirty work. Add focused tests, source manifest, evidence and deployment script. Run related workflow tests; do not run broad unrelated UI regression. NetSuite script upload is external to this workspace: finish and test the exact script before requesting its upload.

Account read-only evidence: active item 10716 has itemId Custom Discount%, itemtype Discount. Account REST metadata exposes rate as a number and no ratePercent field. Use SuiteScript percentage text for creation and in-place insertion so existing native links are preserved. Oracle documents line discounts immediately below their material and setSublistText for percent rates.

Rounding clarification from a failing property counterexample (1 × 8902 at 67.25%): separate lines round gross and discount separately. New quote/form subtotals use gross cents minus rounded discount cents, rather than rounding the net product once. Thus 0.01 at 50% is 0.00 (discount 0.01). No valid percentage is rejected solely for this half-cent difference. The legacy embedded-rate helper remains for already-issued legacy orders. Original rates and discount percentages are unchanged. A missing first PALLET rate must be supplied and reviewed; an already recorded PALLET rate is immutable.

Test contract update: legacy tests that expected a reduced draft material rate now expect the gross rate and separate native discount percentage (e.g. 10 plus -10%, instead of 9). Already-issued legacy retry and migration fixtures explicitly retain unit_rate=9/native_discount_percent=NULL so their original compatibility assertions continue to exercise the old representation. RESTlet version expectation advances from 3.1.0 to 3.2.0.
