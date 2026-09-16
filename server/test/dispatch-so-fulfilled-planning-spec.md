# NetSuite-fulfilled SO Delivery planning

## Authorization and setup

The user requested this rule on 2026-09-15 and explicitly clarified: **only NetSuite-fulfilled orders qualify; a locally completed Driver delivery must not be planned again.**

Spec approval: the behavior was confirmed by the user; separate approval of this written specification was not obtained (autonomous run). This document remains available for review. Verification uses the old-coder Tier 3 workflow because the rule affects admission to operational plans and completion evidence.

Use existing Node, PostgreSQL, fast-check, ESLint, TypeScript, coverage and browser tooling in disposable Docker test environments. Add no dependencies. Preserve all pre-existing workspace edits. Freeze the initial source for baseline comparisons; do not commit, reset, or overwrite the user's work. Produce regression tests, a reproducible verification runner, and an evidence report. Production order cleanup remains a dry run in this task.

## Acceptance scenarios

1. **NetSuite fulfillment without local delivery:** an exact Delivery SO with NetSuite status F/Pending Billing or G/Billed is searchable and planable. Its presentation shows Completed and clearly indicates Driver delivery is still pending. Existing immutable completion evidence stays present; a read does not insert completion records.
2. **Authoritative planning:** a searched fulfilled SO survives plan save, refresh, confirm, and plan reread. Billed-plan cleanup does not silently remove an eligible pending delivery. An unrelated later plan edit also retains it.
3. **Driver completion wins:** an existing or newly recorded completed Driver dropoff removes the planning allowance, including when NetSuite is still F/G. Explicit search may retain a read-only completed card, but the server rejects new planning with the existing Driver-completion conflict. A stale client-supplied eligibility flag cannot bypass the guard.
4. **Pickup is not delivery:** a completed Driver pickup alone does not remove the allowance. Ordinary unfinished SOs retain normal planning behavior, without being described as NetSuite-completed.
5. **SO-only scope:** Pick-Up sales orders, PO/TO orders, genuine NetSuite Closed/Cancelled orders, local Hold/Cancelled records, blocking reconciliation states, manual operational completion, missing/ambiguous identities, and active reload/reattempt work do not receive this allowance. Existing PO reconciliation behavior remains unchanged.
6. **Exact split lineage:** a fully fulfilled source SO can grant the allowance to its active delivery split child. Completing one child does not complete or restrict its unfinished sibling through this new rule. Cancelled split membership and sibling-only fulfillment cannot grant eligibility. Groups cannot use one eligible child to bypass a blocked member.
7. **Bounded discovery:** explicit search and targeted hydration resolve eligible fulfilled SOs beyond the default order pool limit. The default unsearched pool does not become a historical billed-order dump. Already planned fulfilled deliveries remain hydratable. The decision uses local authoritative source data and performs no per-order NetSuite network request.
8. **Evidence preservation:** eligibility reads and plan operations preserve source quantities, packed/loaded/fulfilled quantities, NetSuite statuses, completion event IDs, Driver photos, and existing completed visit evidence. No duplicate fulfillment or fabricated physical delivery is created by granting planning permission.
9. **UI:** eligible cards are draggable when ordinary assignment/dependency/address constraints permit, retain completion information, and show that delivery is pending. Driver-completed cards remain non-draggable/search-only. Existing PO labeling and behavior continue to work.

## Failure model and verification

- Search-only implementation loses an order during save/reread: exercise real repository and HTTP plan paths.
- Billed cleanup removes pending physical deliveries: replay sanitizer and reconciliation cleanup with source and split orders.
- Late Driver completion or forged client flags reopen a completed visit: replay stale-client submission and authoritative guard checks after Driver completion; preserve executed-prefix checks.
- Fulfillment propagates across siblings, pickups, or unrelated order kinds: exact lineage, negative, and property tests.
- Completion gets erased or fabricated: compare immutable evidence, quantities, and photo records before/after read and planning operations.
- Historical billed population degrades ordinary order discovery: preserve bounded default visibility, use batched local lookup, and inspect a realistic read-only query plan.

Run RED before implementation, then focused and existing regression suites, lint/type comparisons, changed-code coverage, plausible mutation checks (also against properties), UI execution, and read-only production replay. Record baseline failures and every unavailable layer explicitly in the evidence report. Do not weaken existing assertions; if an old test describes the intentionally replaced billed-planning behavior, retain its historical contract and add explicit evidence for the new scope.
### Clarification from endpoint verification

The legacy PUT save endpoint and v2 board replacement retain invalid edits as an unapplied recovery draft (HTTP 202), with `DISPATCH_PLAN_RECOVERY_SAVED` and the original rejection under `validationIssues`. Preserve that existing recovery contract: tests must require `applied: false`, the exact Driver-completed validation code, and an unchanged active snapshot. Confirm retains its normal HTTP 409 rejection contract. This corrects the new HTTP test's initial assumption that every rejection used HTTP 409; it does not permit planning a delivered order.
