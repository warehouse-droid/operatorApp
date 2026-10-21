# SO header location correction — SOB121631

Spec approval: not obtained (autonomous run). This correction restores the already requested Sales SO handoff; no new feature or dependency is introduced. Tier 3: ordering-yard identity and concurrent-change checks protect external order writes.

The live read reproduced `REGULAR_SO_MISMATCH`: `transaction.location` is absent for SOB121631, while both its main transaction line and REST header report location 1 (3445). Customer and material identities agree. Read the authoritative main-line location when constructing the SuiteQL header snapshot.

Acceptance / failure model:

1. A missing transaction-body location with matching main-line and REST header locations must read successfully. A stale body location must not override the main line.
2. Join the main line to the same transaction. Other SOs and material-line locations must not determine the ordering yard.
3. A genuine main-line/REST location or customer mismatch must still fail before any order mutation. Missing main-line evidence must fail closed.
4. Preserve keyed material identities, quantities, customer, line-location checks and existing routing/retry behavior. Do not change SOB121631 during diagnosis or verification.
5. Deploy only the corrected adapter over the currently running app, preserve the worker and runtime configuration, and verify SOB121631 read-only afterward.

Setup: existing pinned Node 20/PostgreSQL/c8/ESLint/fast-check Docker tools. No new packages, commits or schema changes. Tests execute the adapter's actual SELECT against PostgreSQL fixtures with only an NVL→COALESCE dialect shim, then use real NetSuite read-only verification. Generate location/customer/missing-main-line variations; mutation checks must reject wrong header sources and removed race protection. Save RED, final tests, changed-line coverage, static checks, mutants, deployment hashes and live read evidence.

## Explicit user clarification during implementation

PALLET and discount items do not count as requested stock when deciding whether the entire order has one source. With two requested material lines from 2967 and a PALLET line, SOB121631 must use location changes, including PALLET, rather than a TO. Discount lines follow the same rule. Preserve their quantities/rates and handle quantity-less discount lines without NaN snapshot comparisons. Genuine extra stock still requires the transfer route. A concurrent PALLET/discount price or fulfillment change must block the write.

The SO's ordering header remains the Sales yard; the approved source is applied to the SO item lines, as specified in the original workflow. Live verification previews this route and never executes a customer's order.

## Subtotal and observed line types

The user additionally requested subtotal handling and authorized inspecting stored SOs. The database contains Inventory Part, Kit, Non-Inventory Part, Other Charge, Service, Discount, Subtotal and Markup lines. PALLET is an Inventory Part with item ID 1784. Subtotal uses NetSuite's built-in item ID -2, which is absent from the item master; some mirrored subtotal types are blank. A read of SOB121627 confirmed the -2 SuiteQL line with a missing item-master type.

Include structural lines through a LEFT JOIN. Recognize subtotal by its exact -2 identity, retain its keyed SO line, and do not require positive inventory-item identity or quantities for it. Inventory/assembly/kit lines determine stock routing, except PALLET. The observed non-stock types do not force a TO and follow a complete single-source location change, with their prices and row ordering preserved. Unknown types must fail closed rather than silently hide potential stock. Tests must exercise the real SQL join, subtotal without a master item, pricing-only rows, and genuine extra stock. Final live checks must read SOB121631 and SOB121627 and preview STREQ-000059 without writing orders.

The user explicitly confirmed delivery fees belong to this exclusion. Stored delivery fees are Other Charge items, including Delivery Fee item 3013 and Delivery Charge item 1987. Add an explicit fee preservation regression. SOB121627's SuiteQL subtotal is confirmed, but NetSuite refuses its REST GET because a workflow has locked that order; use another readable subtotal example for live REST verification and never bypass its lock.
