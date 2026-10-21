# Special request batch saves and final discount (2026-09-28)

Spec approval: not obtained (autonomous run). Tier 3: transactional saves and order amounts.

Acceptance criteria:
1. SCM displays one Save stock check button for all editable case lines, including accepted-line readiness. One request saves the set atomically with one case revision increment. Mixed stock, production and transfer statuses retain their own ETA, yard and notes.
2. Sales displays one Save customer decisions button. Each pending line has an explicit choice; blank choices remain pending. One request saves the selected decisions, with a reason required for declines. Existing accepted/declined lines remain unchanged.
3. Invalid ETA/reason, foreign/duplicate line, wrong yard, stale revision or locked case saves nothing, including audit events. Concurrent saves from the same revision yield one success and one conflict. The existing individual endpoints remain compatible.
4. Browser validation and failed requests preserve all line values independently. No nested forms; desktop and mobile expose one save per section.
5. New SO payloads contain material and ancillary rows plus one flat order-total discount using NetSuite discountItem 10716 and discountRate. The amount equals the sum of individually rounded material discounts; pallet charges are excluded. Sales discounts remain per line in the application. Existing legacy SOs retain their format.
6. Verification, canonical matching, later quantity/discount adjustments and PO creation support the combined final discount as well as existing legacy per-material discounts. Retries must not duplicate discounts or recreate linked materials.
7. No corrective writes to SOM06738, no backup, no repository-wide regression or unrelated source deployment. One additive migration stores the selected Sales Rep, new SO discount mode and private vendor discount review, without backfilling existing cases.

Failure model and checks:
- Partial batch writes/lost edits: real PostgreSQL rollback tests and browser failed-save/retry checks.
- Concurrent/stale saves or cross-case access: real concurrent transactions and authenticated HTTP checks.
- Wrong rounding, discount duplication, pallet discounting: exact cents examples plus generated arithmetic properties and boundary contract tests.
- Broken native PO links/legacy orders: preserve material IDs and exercise existing PO/adjustment suites against mocked NetSuite transport.
- UI regression: real Chromium desktop/mobile checks and screenshots.

Setup: use existing isolated Docker PostgreSQL/Node/Chromium, node:test, fast-check, ESLint, TypeScript and c8. No packages added, no git commits. Add focused tests, reproducible check/mutation/release scripts and source hashes. No live NetSuite transaction is used for testing. Live validation is read-only.

Clarification from user: Sales discounts remain per line in the application and consolidate when the SO is created. The PO requires SCM to explicitly confirm its own vendor discount, which may differ from Sales. That vendor discount must not be defaulted from the SO. User confirmed one total vendor discount amount; required zero means no vendor discount.

Implementation clarification: Oracle documents that a line discount applies only to the preceding item. The combined SO discount will therefore use NetSuite's transaction discount (discountItem 10716 and a flat discountRate), shown in final order totals, rather than discounting the last material or PALLET. Revised scenario 5: new SO item rows contain only materials/ancillaries, with one total discount in the header. Legacy per-line orders remain compatible.

Additional user requirements: SCM enters one total vendor discount amount. Allocate that amount across net PO purchase costs while preserving the exact approved net total and native links; the review shows gross cost, discount and net cost. Store the original costs and confirmation durably and keep these vendor figures SCM-only. An active NetSuite Sales Rep must be selected before SO creation; validate the selection against NetSuite again before submission. The selected SO rep is separate from the request/quote author. Add one nullable/additive migration for selected rep, SO discount mode and vendor review; no backfill or existing-order correction. Test missing/inactive reps, zero vendor discount, over-discount, rounding, retry and private projection.

User correction for SPREQ-000011: canonical SO/PO material reconciliation must ignore discount rows completely. SO and PO discount counts and amounts are independent. Keep material identity/quantity/UOM/description coverage; remove the discount-count gate, including during adjustment recovery. Native PO linkage must likewise match materials only and preserve any independent PO discount rows. Inspect and revalidate SPREQ-000011; no remote order corrections and SOM06738 remains untouched.

Live evidence refined the non-material filter: SPREQ-000011 / SOM06738 contains six matched Special material rows, inactive legacy 10716 discount rows, a built-in Subtotal item (-2), and an active alternate discount item 2022 (NetSuite item type Discount). Ignore all Discount/Subtotal types and the known built-in subtotal. Preserve rejection of genuinely unreviewed material rows. Native PO lookup resolves any other item IDs through NetSuite item types before ignoring them; it never infers a discount merely from its name or zero quantity.
