# Reconciled split on-order calculation — evidence

spec approval: not obtained (autonomous run)

The user authorized correcting the calculation and auditing all current items.
Specification: [reconciled-split-inbound-spec.md](reconciled-split-inbound-spec.md).

## Cause and correction

PER-MEL60-COP-RB / 2967 was overstated by 546 PC / 13 PLT. POB03535 line
4565794 was fully received through IR13416 on July 16, 2026, memo
3022033418（TO 2967）. Reconciliation allocation 6718 recorded 546 received
against split ledger line 32. The virtual child's own receipt counter remained
zero. The shared on-order SQL did not consult the reconciliation allocation.

The helper now includes active received allocations for the exact split line in
the greatest cumulative receipt total. It never adds overlapping receipt totals.
The change is 14 added lines in one application file. No order quantities,
receiving records, dispatch plans, dependencies, or schema were changed.

The newly created POB03885 remains 252 PC / 6 PLT incoming. Current verified
available is 85 PC / 2.02381 PLT; on-order is 6 PLT; expected is **8.02381 PLT**.
Saved proposal 34678 / line 120330 retains the user's **2-PLT** quantity.

## Final live audit

Captured: 2026-09-17T13:31:03.049Z. Read-only repeatable-read audit completed in
47.288 seconds.

- 1,455 locally recorded items; 5,817 item/yard records across all four yards.
- 778 current planning states; zero independent arithmetic discrepancies.
- 96 formerly overstated split lines; the pre-fix snapshot audit identified 38 affected item/yard balances.
- Zero remaining split-supply conflicts with fully received, closed or inactive source orders.
- Fresh NetSuite catalog sync: 1,344 active items and 5,376 balances (including canonical zero yard rows), sync run 158.
- Inactive/historical local inventory records absent from the fresh NetSuite result had no positive incoming quantities.
- Refreshed 276 current editable proposal lines in runs 395 and 396; 27 on-order figures changed. Both runs advanced revision 2 → 3.
- Zero remaining current saved-proposal on-order discrepancies. Preview, rolled-back rehearsal, apply and idempotent verification passed.
- Fingerprints prove proposal headers, all non-evidence line fields and frozen phase decisions were preserved. Completed/issued proposals and historical runs were excluded from evidence maintenance.

The CSV [corrected-on-order.csv](/home/ubuntu/operatorapp-investigations/on-order-20260917/corrected-on-order.csv) separates formula corrections from fresh inventory quantities.
Raw before/after audits, NetSuite inventory, and refresh evidence are retained in `/home/ubuntu/operatorapp-investigations/on-order-20260917`.

## Verification

- Six new calculation tests, thirteen existing completion/receipt tests and three maintenance tests pass: **22 focused tests**.
- Initial new calculation tests: 5/5 observed assertion/property failures before implementation. Maintenance: 3/3 observed failures before implementation.
- Same-split line isolation was added after the initial green run and its missing-correlation mutant is detected.
- Related suite: 50/51 pass; one reproduced baseline failure. Reversed file list: 49/51 pass; two reproduced baseline failures. Zero new failures.
- Manual mutation: 5/5 faults detected, covering ignored reconciliation, inactive allocations, fulfillment versus receipt, wrong line, and double subtraction. Attribution is to the complete suite, not properties alone.
- Seeded arithmetic properties: 60 receipt-allocation cases (seed 5057), plus the existing 40 cumulative-receipt cases (seed 3737).
- Helper coverage: 43/43 lines; every changed line exercised. V8 counts generated SQL construction; PostgreSQL assertions verify SQL behavior.
- v20.20.2; TypeScript 7.0.2 check passes for the changed application helper. Syntax/lint and secrets scan pass for the helper, focused tests, maintenance and audit scripts. Helper complexity ≤ 12.
- Deployment health passed. Each app/worker image was derived independently from its existing running image and contains only the changed calculation helper.

Baseline failures, unchanged:

1. `smart-scm-harness.js`: `AssertionError: Expected active item_master input.`
2. Reverse order additionally exposes `smart-scm-vendor-alternative-harness.js`: PostgreSQL integer overflow in fixture IDs.

## Reproduction and limits

From the repository root:

```sh
bash server/tools/reconciled-split-inbound-gauntlet.sh
python3 server/tools/reconciled-split-inbound-evidence.py
```

The gauntlet uses cached image `mbbs-retired-confirm-test:20260914` and disposable
PostgreSQL 18 databases on an internal Docker network. The original helper is
persisted in `test/support/reconciled-split-inbound-baseline.js`; baseline and
current runs compare unchanged assertions. Live audit and maintenance entry points
are `reconciled-split-inbound-audit.mjs` and `reconciled-split-inbound-live.mjs`.
Do not repeat the historical apply command: current-run revision guards reject it.

No whole-application test run or browser interaction was performed; affected SCM
repository consumers and real production reads were exercised. No NetSuite writes
were made. Dependency audit/license checks were unnecessary because dependencies
did not change. Static types cover the changed helper, not the unrelated transitive
application graph. Inventory and reconciliation are snapshots; later business
transactions can change the quantities after the audit timestamp.

Application helper SHA-256: `9be9fbcb77e65ca6999642c2fa261abcdb2f2576f0668ac1953787f5227a2125`.
Deployment backup: `/home/ubuntu/operatorapp-deploy-backups/reconciled-split-inbound-20260917`.
