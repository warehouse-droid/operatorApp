Special Request custom PO linkage and SPREQ-000024 SQFT repair — Tier 3.

Spec approval: not obtained (autonomous run). The user requested a PO number input next to Create PO that links an existing PO independently of SO details, without updating SO descriptions, and correction of SPREQ-000024 to SQFT.

Acceptance criteria:

1. SCM can enter an existing PO number next to Create PO and submit Link PO without filling the new-PO cost fields. Preserve typed input during refresh. Resolve the number from the local NetSuite mirror, case-insensitively, and reject missing or ambiguous matches. Standard PO creation and strict standard linkage retain their existing behavior.
2. Persist custom linkage explicitly. Do not call NetSuite, create a PO, synchronize SO descriptions, or compare PO items, descriptions, quantities or UOM with SO details. Preserve all saved SO and PO draft lines and prices. PO webhooks continue to respect custom linkage after restart; SO webhooks still validate the SO itself.
3. Keep SCM authorization, locked revision, active/approved SO, active PO, vendor and destination yard, exclusive ownership, no existing allocations and no in-flight operations. Failed linkage changes nothing. Audit the PO number and explicit bypass. Preserve unrelated SO Attention.
4. Custom linkage does not fabricate SO-to-PO line allocations. Vendor-to-yard arrangement remains available after canonical SO identities and PO lines exist; direct allocation requires an independently established line relationship. Explain this route choice to SCM.
5. For SPREQ-000024, verify NetSuite SOB121882's exact three material identities, quantities, rates and SQFT units, PALLET at 8 x 40 EACH and the existing 1 x 235 delivery charge. Update only the six saved material SO/PO UOMs and three case-line sales/purchase UOMs from PC to SQFT. Preserve quoted SQFT basis, descriptions, quantities and prices. Save a before image, audit the correction and use normal reconciliation to resolve Attention. Abort atomically on any unrelated change. No NetSuite write.

Failure model: linking the wrong PO (identity/vendor/yard/ambiguity/ownership tests); accidental SO edits or comparison (different item, quantity, UOM and description fixtures, outbound network blocked, unchanged row assertions); bypass leaking into standard creation (existing workflow regressions); refresh losing input (desktop/mobile browser tests); stale/unauthorized writes (HTTP and rollback assertions); invented allocation (route test); wrong unit correction (guard/property/mutation tests and live read-back).

Use the existing isolated Node/PostgreSQL/Playwright runner. Add one default-false custom-linkage column. Capture incremental before files. Exercise acceptance tests against captured source before implementation, compare affected regressions to the earlier captured live baseline, and update the combined prepared release without publishing it until deployment approval is given.
