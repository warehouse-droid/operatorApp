# Created Smart SCM PO synchronization

Spec approval: not obtained (autonomous run); implementation authorized by the user's request.
Tier 3: purchase-order financial data and synchronization.

## Acceptance criteria

1. POB03875 regression: a created PO whose original material rows were 4778 / 8 PLT, 4775 / 5 PLT, and 5055 / 10 PLT displays the current NetSuite rows 4778 / 10 PLT, 4775 / 5 PLT, and 4795 / 8 PLT, plus PALLET / 23 EACH. Removed items disappear; added or replaced items appear.
2. Current quantities, units, prices, amounts, destinations, dates, vendor reference, status, material pallets and total weight come from the canonical PO mirror. Missing prices remain unknown. Original proposal and creation evidence remain immutable.
3. Only linked regular POs use this projection. Drafts, uncreated proposals and Blanket workflows retain their existing behavior. An empty current PO must not resurrect original lines; duplicate items remain distinct by NetSuite line identity.
4. A created PO in Vendor Replies has a direct link to the existing editor. Opening this link loads and refreshes that specific PO without archiving it. Existing history browsing remains archived by default. Authorized edits write the same NetSuite PO and read it back.
5. Vendor Replies can refresh linked created POs and periodically reconcile them while visible; duplicate refreshes are bounded and errors remain visible. No vendor email is sent.
6. Partial webhook payloads without prices do not erase known canonical rates and amounts. Explicit reconciliation remains authoritative. Failed refreshes do not partially commit canonical rows.
7. Changes within the same day must be distinguishable by the PO edit version; received/closed/inactive POs and stale edits remain blocked.

## Failure model and verification

- Stale/replaced/removed/duplicate lines: exact production-shaped fixture, property checks and PostgreSQL integration test.
- Incorrect money or units: native quantities and explicit PALLET lines; missing-rate tests; existing financial and conversion suites.
- Lost audit evidence: frozen input assertions and database snapshot comparisons.
- Partial writes or refresh failure: transaction rollback test and readback error assertions.
- Stale edits: service and transport boundary tests; no test writes to live NetSuite.
- Broken UI or access: execute browser functions with fixtures and verify API authorization remains in place.

## Setup and boundaries

Use existing Node, PostgreSQL, ESLint, c8, fast-check and browser tooling from an isolated Docker test image. Add focused test fixtures, a reproducible verification script and an evidence report. No new packages, migrations or checkpoint commits. Preserve unrelated working-tree changes. Live investigation uses read-only NetSuite calls; final verification may refresh the local mirror of POB03875. Test writes use an isolated database.

### Investigation refinements

- NetSuite SuiteQL returns date-only modification values in this account. Compare a digest of current PO header and line content for edits, in addition to the existing date check; recheck it immediately before the outbound update. This avoids treating same-day changes as the same version.
- Corrected the fixture's hand-calculated total weight before implementation: 932.8 × 40.55 + 466.4 × 40.55 + 932.8 × 29.08 + 23 × 40 = 84,783.384 lb.
- The vendor staging workflow moves source lines into the review proposal. The audit-preservation integration assertion therefore checks the immutable creation snapshot and saved review rows; an empty source proposal is expected after staging.
- Both HTML entry points must request the new `20260915-created-po-sync-v1` JavaScript assets. Existing exact cache-version assertions are advanced to this required version; their checks remain strict.
- Coverage is enforced on every changed backend line, including the two new modules. The inherited whole-file percentage included thousands of unchanged NetSuite adapter lines, so coverage collection uses a separate strict changed-line check. The existing repository coverage configuration is unchanged.
