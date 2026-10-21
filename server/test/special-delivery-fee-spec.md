Special Request delivery fee — Tier 3 (customer money).

Spec approval: not obtained (autonomous run). Sales explicitly requested a manually entered delivery fee below PALLET, charged only to the customer, excluded from PO matching. The later SPREQ-000024 repair is also authorized.

Acceptance criteria:

1. Selecting Delivery displays a required Sales rate field directly below PALLET in the initial request and SO draft. Sales can enter 235 or explicitly 0. Pickup displays no fee. Rerenders and copying retain the entered rate.
2. Persist the optional rate on the request. Quote preview and saved quote include exactly one undiscounted charge at quantity 1, including tax in the normal totals. Saved and newly entered fee values cannot produce duplicate charges. Legacy requests without the field retain existing ancillary charges.
3. Saving the SO draft adds item 1987 (Delivery Charge) once with the entered rate and no fabricated units. The fee never becomes a PO line, material stock check, customer material decision, or PO matching requirement. Preserve exact material and PALLET matching.
4. Reject negative, nonfinite, malformed and overprecision rates. Missing legacy values remain compatible; new UI submissions require an explicit rate. Preserve access checks, revision checks and atomic saves. Pickup ignores hidden fee values.
5. SPREQ-000024/SOB121882: verify unchanged material/PALLET identities, quantities and prices; adopt only the observed added packing descriptions and existing single item-1987 charge at 235. Retain PO lines without delivery. Use the normal reconciliation to clear Attention; never force-clear it or write to NetSuite. Guard against concurrent changes and record an audit event and before image.

Failure model: duplicate billing (deduplication and SO/quote tests), supplier charge leakage (PO and coverage tests), losing Sales input (browser/copy/persistence tests), invalid money (adversarial/property tests), wrong NetSuite UOM (unitless item adapter test), unauthorized/stale update (existing endpoint/revision tests), an unrelated line change being accepted (strict repair guard and existing coverage tests).

Setup: existing Docker Node 20, PostgreSQL test database, Playwright, ESLint, TypeScript, c8 and fast-check. No dependencies or commits. Add one nullable bounded numeric column, tests, a reproducible runner, guarded one-off repair script and evidence. Capture pre-edit files to identify the task diff in this already dirty workspace. Exercise the migration only in the isolated test database before release. Scope runtime release to the task files; do not publish unrelated work.

Appendix — user-requested submission performance:

6. New request submission uses only local data and targets <1,000 ms per authenticated HTTP save. Sales Rep options fetched while opening the form are persisted locally and validated by ID on submit, including after restart; client-supplied names are not trusted. Actual NetSuite SO creation retains fresh remote validation. Invalid or unavailable selections fail promptly without creating a case. Avoid reading Dispatch plans for a new request. Add a nullable-data-safe sales-rep cache migration and benchmark realistic one-, ten- and 100-line requests with outbound network disabled. Browser success appears immediately after the POST response, without another queue request.

Compatibility clarification: copied historical Delivery requests without a fee require Sales to enter a rate (including explicit 0) before submission. The existing copy-browser fixture now supplies that new required input; its assertions about copying, preservation and explicit submission remain unchanged. Historical quantity-based delivery lines retain their quote quantities/amounts; copying combines their complete customer charge into the new single-fee input.
