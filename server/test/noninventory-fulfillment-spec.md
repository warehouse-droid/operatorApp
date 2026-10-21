# Non-inventory resale fulfillment exclusion

User request: keep non-inventory resale items visible and ignore them when posting fulfillment, for SOM06789 and all future orders.

The application represents these items as `NonInvtPart`. Apply the exclusion to all `NonInvtPart` fulfillment lines, without item-name or order-number exceptions. Inventory fulfillment and non-inventory receiving retain their existing behavior.

## Acceptance criteria

1. A mixed SO or TO keeps its non-inventory lines and local quantities visible. IF payloads contain inventory selections and inventory deselections only; ignored lines are completely absent, including `itemReceive: false` rows.
2. Stored and live source resolution ignores non-inventory IF lines before validating transform identity. Missing transform identities on ignored lines cannot block inventory posting. Receiving continues to accept non-inventory items.
3. A pickup or delivery operation containing only packed non-inventory lines completes locally without creating an IF. An order with no packed lines still reports the existing validation error.
4. Recording inventory fulfillment does not mark excluded lines as fulfilled or count them as outstanding IF work.
5. Future delivery-completion candidates and live fulfillment reads exclude non-inventory rows. Exact inventory identity, quantity, location, idempotency and recovery behavior remain covered by existing fulfillment suites.
6. Kit components remain local membership evidence. Only the kit parent is posted; standalone non-inventory lines never become IF rows. Inventory kits containing a non-inventory component still map to the correct whole-kit quantity.
7. Type determines exclusion even with arbitrary names, quantities, item IDs, line order, and enabled/disabled NetSuite fulfillment settings. No client input can override it.

## Failure model and checks

- An excluded row reappears as a deselection: payload assertions plus mutation tests.
- Ignored transform identities prevent a valid inventory fulfillment: stored/live resolver tests and read-only SOM06789 preview.
- Inventory rows or quantities are accidentally removed: properties asserting exact inventory selections, existing posting and kit suites.
- An ignored line keeps fulfillment partial or is incorrectly marked fulfilled: isolated repository tests.
- A receipt or kit stops working: receiving contract and whole-kit regression tests.
- Production release overwrites other work: capture the current image, apply a scoped four-file overlay, compare every runtime source/public/migration hash, preserve configuration and dependencies, prepare rollback, and check no posting operation is active before restart.

## Setup and authorization

Use existing Docker test images, Node's test runner, fast-check, TypeScript, ESLint and V8 coverage; add no dependencies. Save tests and reproducible verification/release scripts in the repository. Use a disposable internal-network database; production checks are read-only and do not retry or create a customer IF. Do not create commits or modify unrelated working-tree changes.

Tier: 3 (external inventory/financial posting). Spec approval: not obtained (autonomous run); scope follows the user's explicit instructions. The user reviews the recorded spec and evidence after implementation.

Additional acceptance criterion discovered during reproduction: an automatic delivery completion containing only non-inventory lines records `skipped` with empty payload and no NetSuite transaction, rather than waiting for irrelevant delivery evidence.

Verification scope clarification: the complete 714-file MBT suite was attempted with both the ordinary test image and the browser image. It stalled in unrelated browser workflows (missing Chromium in the ordinary image; aggregate-request browser workflow in the browser image). Keep these logs and disclose the incomplete broad-suite run. Compare all existing fulfillment, posting, kit, line-mapping, pickup, receiving-posting, child-location and consolidation suites against the captured baseline; do not alter or weaken their assertions.
