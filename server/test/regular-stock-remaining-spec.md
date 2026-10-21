# Physical balance for Regular Stock

The user approved billing-independent physical eligibility and explicitly confirmed that a closed line has zero actionable balance. This specification records the implementation details of that approval; detailed executable spec approval was not obtained separately (autonomous run).

SO balance is `closed ? 0 : max(ordered - fulfilled, 0)`. PO receipt eligibility continues to use ordered minus received; this change must not introduce a billed-quantity condition there. Native terminal order status checks and protections on financial edits remain in place. Dispatch and Driver changes belong to the user's other thread.

Acceptance criteria:

1. An open SO line with ordered 100, fulfilled 0 and billed 100 is eligible for 100. A partially fulfilled order (native D/E), ordered 100, fulfilled 40 and billed 100, is eligible for 60.
2. Closed lines have remaining 0 regardless of original quantity. Fully fulfilled lines have remaining 0. Neither can be selected; an unrelated closed/completed line must not prevent work on an eligible line.
3. Regular Stock matching and allocation use the remaining balance. A request for 60 matches the 100/40 line; a request for 100 fails. Duplicate item rows preserve their identities and conserve the approved quantity.
4. Delivery transfer calculation can select the whole remaining balance or the backorder, subject to availability. It cannot exceed remaining quantity; inconsistent backorders fail. For 100/40 with backorder 20, ample stock transfers 60, not 100.
5. A billing-only change, including hidden kit components, does not invalidate operational approval. Changes to fulfilled quantity, closed state, identity, unit, location, or approved physical quantities still invalidate a stale action before mutation. A lost response/retry must not duplicate a transfer or location patch.
6. Location-only changes preserve ordered quantities, header, rates and line identities. Closed/completed ancillary lines are not moved. Quantity-less financial ancillary lines continue following eligible stock.
7. Legacy saved snapshots without fulfillment fields represent the previous unfulfilled-only contract. A fresh partial fulfillment cannot be mistaken for that legacy state. Malformed physical quantities/closed flags cannot be silently accepted.
8. Delivery UI explains that the maximum transfer is the remaining SO quantity.

Failure model: over-transfer from using original quantity (example + property tests); stale approvals after fulfillment/closure (boundary + database retry tests); billing coupling in kits (adapter tests); malformed quantities (adversarial cases); duplicate retries (existing integration coverage); shared host interference (bounded isolated Compose, teardown registered before startup).

Setup: use existing Node test runner, fast-check, TypeScript, ESLint and c8 from the existing test toolchain. Add focused regression/property/integration tests, a persisted runner, mutation checks and evidence. No dependencies, schema changes, commits, production NetSuite writes or deployment are required. Preserve concurrent work. Use the standard isolated Compose configuration with task-specific read-only source mounts and disposable database; remove this task's containers/volumes/network at each run's end and record production health. Full affected Regular Stock suites, types/lint, changed-line coverage, five plausible mutations and reverse suite order form the gauntlet; record any baseline failure rather than weakening assertions.

Scope clarification from the user's type questions: the affected request types are **Pickup and Delivery**, which use SO linking/routing. The separate **Backorder** request type and **Stocking** types retain their existing behavior. “Backordered SO lines” in the scenarios describes a line quantity, not the Backorder request type. Confirmation tokens must also ignore billing-only kit changes. Nine mutations were selected to cover these guards and retained native terminal status behavior.
