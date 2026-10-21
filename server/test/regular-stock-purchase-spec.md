# Stocking Purchase acceptance specification

Spec approval: obtained through the implementation plan and “Implement the plan”.
Tier 3: purchasing quantities, authorization, concurrent retries and external-order traceability.

1. Only Stocking offers Purchase/Transfer. Omitted mode means Transfer. Purchase has no source yard, no all-yard refresh or availability limit, and always enters manual review.
2. Display current-yard on-hand, available and preferred stock; unavailable evidence is not zero. Other yards must not be fetched to submit Purchase.
3. SCM reviews selected items, can adjust quantity, and automatically sees whole-pallet upward rounding (150 EA / 100 EA per pallet => 200 EA). Preserve requested quantity. Missing conversion/vendor-yard blocks acceptance.
4. Atomic, revision-protected Add to PO/TO proposal accepts selected items once. Group by vendor yard across requests/destinations, respecting truck capacity and stops. Force vendor PO, without SO/TO creation.
5. Stable demand and per-line quantity allocations survive independent loads, grouping with ordinary loads, identical-item combination, capacity splits, recalculation, vendor partial confirmation and retries. Carry outstanding quantity once; count entire carried load coverage once in ordinary planning.
6. Only a real linked PO or explicit release stops outstanding carry. Partial PO placement preserves the remainder. Reduction/removal/cancellation requeues outstanding demand. Release affects unordered amounts and preserves history.
7. Show directly linked orders and other active incoming POs at the item's actual destination, including number, reference, open quantity, status and ETA. Informational orders never fulfill demand.
8. Shared quantities and receipts are allocated in acceptance order and capped. Accepted persists until all unreleased accepted quantities are actually received; fully rejected/released requests close without fabricated receipts.
9. Preserve current Transfer/Pickup/Delivery behavior, permissions, alerts and English/Chinese labels. Stale/concurrent requests must not create duplicate quantities. No production records or NetSuite orders in tests.

Setup: existing Docker Node 20, PostgreSQL 18, Playwright, node:test, fast-check, ESLint, TypeScript and c8 only. Dedicated test database; no new dependencies or checkpoint commits. Existing workspace changes are preserved in the task baseline. Reproducible tests, mutation checks, static checks and evidence will be persisted in this repository. Record unavailable layers and existing failures rather than weakening assertions.
