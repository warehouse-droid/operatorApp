# Return and exchange layout — 2026-10-29

Deployed at **19:35:13 UTC** as `mbbs-operator-app:return-exchange-layout-20261029`,
image `sha256:8054fbb68a987f604e5ce7f2928609d5023362ec669cc5206084a2d8a2ba8bd9`.
Six public assets were overlaid on the captured `repair-flow-manual-20261029`
image. Runtime configuration and the other production services were preserved;
no migration or posting-gate change was required.

The approved UI requests are implemented together:

- Pallet Return sits above the scrolling stock list. Its badge, title and
  balances stay inside its border at the tested widths.
- Stock Return and Stock exchange share the same font rules and account-setting
  minimums (16px default text, at least 15px with small preferences), and two
  physical-unit inputs per row.
- The calculated-quantity panel is removed from both editors. Quantity
  calculations, remaining/returning totals and over-quantity validation remain.
- Remaining/Returning labels and values share a line at 1365 × 800. Cards use
  content height with an 80px minimum, allowing at least three complete stock
  cards in the visible list with the real top bar and the pallet card present.
- Customer, Sales Order, Ordering yard and Receiving yard are separate blocks
  with two text elements each and a 4:2:1:1 width ratio. Phones retain a vertical
  summary. The customer address was removed from this compact summary to meet
  the requested two-line height. A Chinese Ordering yard label is included.

The original browser run reproduced smaller exchange text, four tablet input
columns (one on phones), pallet overflow at 768px, and only two complete stock
cards at 1365 × 800. The final exact candidate passed **54 Chromium cases and
8 unit tests**, plus JavaScript syntax and diff whitespace checks. Widths:
320, 390, 768, 1024, 1365 and 1440px; default, 8px and 24px preferences.
Existing regressions cover physical and sales-UOM editors, reason additions
with preserved scroll/data, 48px quantities, photo validation and floating errors.
One updated summary expectation initially omitted the existing uppercase CSS
transformation; the expected displayed label was corrected to ORDERING YARD.

Reproduce with `python3 server/tools/return-exchange-layout-release.py validate`
while its retained candidate exists, or run
`DISPATCH_SOURCE_SKIP_BUILD=1 DISPATCH_SOURCE_NO_DB=1 bash docker/run-dispatch-source-tests.sh node tools/return-exchange-layout-checks.mjs`
against the workspace. Release source hashes and production verification are in
`server/deployments/return-exchange-layout-20261029`. Live asset hashes and health
matched after deployment.

## Approved deleted test cleanup

The user separately approved voiding **SE-000001** and clearing deleted
**IT00582**. Exact-ID NetSuite reads confirmed transfer 1101179 does not exist.
At **19:35:59 UTC**, the guarded transaction voided record 70, cancelled its
posting status, and cleared only the 3445 / October 2026 monthly transfer link.
The local reservation for SOB121307 line 5022059 decreased from **10.21 SQFT to
0**. Original transfer identity, intent, proof, confirmed lines and prior events
were retained; cleanup event **17780** records the action. No NetSuite write was
made. The database requires an operator for void attribution, so the original
submitter is retained there; the void reason and separate system event explicitly
identify this execution as user-approved system maintenance.

Before applying, five isolated database scenarios passed: read-only preview,
exact quantity release/history retention/idempotency, ambiguous failures and
changed quantities, shared-month refusal, audit-failure rollback, and concurrent
requests (the first scenario combines related checks). Three deliberately faulty
versions were rejected: allowing an existing remote transfer, allowing a shared
month, and leaving the stale monthly link. Coverage of the operational helper:
71/74 lines (95.94%), 1/1 functions, 19/21 branches (90.47%); the stdin CLI branch
was subsequently exercised by the live preview and apply. The initial rehearsal
caught the required void-attribution constraint; production remained unchanged
until the corrected rehearsal and all mutation checks passed.

Reproduce cleanup checks with
`DISPATCH_SOURCE_SKIP_BUILD=1 DISPATCH_SOURCE_MIGRATIONS=/home/ubuntu/apps/operatorApp/server/migrations bash docker/run-dispatch-source-tests.sh node tools/stock-exchange-test-cleanup-checks.mjs`.
Helper SHA-256: `71a26ae23396d84d95c9fef2e1d3524fc3fc3a8be8cbe9e8c35747e977d8da5a`.
Operational preview/apply records are retained with the deployment. This is a
bounded, exact-target maintenance tool, not an automatic missing-transfer policy.
No dependencies changed. Types, a separate lint/complexity run and a property-only
mutation run were not performed for this one-time maintenance tool; its real
database, rollback and concurrency scenarios are the main safety evidence.

All test environments used the shared `mbbs-tests.slice` budget and the retention
wrapper. Containers, disposable databases, networks, mutation copies, coverage
and other generated test output were removed after each run, including failures.

## Pallet position correction — 21:35:53 UTC

The user clarified that Pallet Return must stay at the bottom. The footer now
follows the stock list and pagination, with its separator above it. The compact
card contents and all other layout changes remain intact. This supersedes the
earlier choice to place the pallet card above the list.

Deployed as `mbbs-operator-app:return-pallet-bottom-20261029`, image
`sha256:e2cc35bf0ec7f945192bf6eefe22a308497a0a230a17348cfe9420ae016441e7`.
Only the selector position, footer separator and two asset cache URLs changed.
The exact candidate passed all 54 browser cases and 8 unit tests, including the
updated bottom-position assertion, full pallet-card containment and three full
stock cards at 1365 × 800. Production source hashes, health and configuration
preservation passed. Reproduce through `tools/return-pallet-bottom-release.py`;
operational records are in `deployments/return-pallet-bottom-20261029`.
This task's test containers, network and artifacts were removed. A separate
active repair test project was observed during the final Docker check and was
left to its own runner's teardown.
