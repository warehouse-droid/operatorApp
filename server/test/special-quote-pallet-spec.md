PALLET on the initial Special Request quote

Tier 3: this change persists quoted prices and affects quote totals. Spec approval: not obtained (autonomous run under the user's existing implementation and deployment authorization).

Acceptance criteria:

1. A new Special Request has a PALLET quantity input, initially 0, and a sales-rate input before Preview quote and Submit to SCM. These are separate from material packing counts.
2. With quantity 3 and rate $40, both draft and saved quotes include exactly one PALLET line, 3 EACH at $40. Material discounts do not discount PALLET. For a material gross amount of $200 with a 10% discount, the subtotal is $300, 13% HST is $39, and total is $339.
3. With PALLET quantity 0, the quote omits PALLET entirely and excludes its amount from totals. A free PALLET with positive quantity and rate 0 still appears. Old requests without the new inputs remain valid.
4. Submit to SCM stores quantity and rate in existing case columns. The saved quote, copied draft and subsequent SO draft retain those values. Previewing a draft creates no request, Sales Order, Purchase Order or NetSuite record.
5. A header PALLET amount and an existing SO-draft PALLET line produce one charge. Explicit header quantity 0 removes a stale SO-draft PALLET charge. Legacy requests with only an SO-draft PALLET line retain that charge and packing information.
6. Quantities must be whole numbers from 0 to 1,000,000,000. Positive quantities require a non-negative rate, including 0, with at most six decimals. Invalid types, unsafe quantities/rates and unsafe monetary totals are rejected before persistence or PDF rendering.
7. Unrelated ancillary charges, material prices/discounts/packing, quote summaries, private SCM costs, Sales yard permissions and workflow gates retain existing behavior. Previous Add item, Copy request, PALLET PO/SO review, SCM mini-panel and PO/TO schedule changes remain deployed.

Failure model: missing or duplicate charges (snapshot and real-PDF assertions); incorrect HST/discount rounding (independent integer-arithmetic properties); lost values across rerender/copy/save (browser plus authenticated HTTP/database tests); hostile input/overflow (validation and no-partial-write assertions); unintended NetSuite writes (isolated direct-access-disabled runner and outbound-call guard); unrelated deployment changes (captured-live overlay and complete runtime hashes). New inputs use existing transactions and columns, so no migration or new concurrency mechanism is needed.

Setup: reuse the installed Node, Playwright, PDF parser, TypeScript, ESLint, c8 and fast-check in the existing isolated test runner/database. Add tests and reproducible check/release tools. No dependency installation, git initialization/checkpoint commits or migration. Capture the live image, build only the selected source overlay, retain rollback, and verify deployed health/public hashes and unchanged service configuration.
