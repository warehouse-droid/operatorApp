# Operator kit fulfillment — approved implementation spec

Approval: user said “Implement the plan.” after the kit-aware fulfillment plan and selected complete kits only. Tier 3: inventory quantities and irreversible external posting.

## Acceptance criteria

1. SOB120656 / SO 997764: physical item 2141 quantity 95.6 at local stable line 4974656 and component item 599 quantity 1 at stable line 4974658 produce IF parent orderLine 1 quantity 95.6 and kit parent orderLine 2 quantity 1. Never post child orderLine 3. Preserve component confirmations and the parent/member relationship in immutable command JSON.
2. Resolve the current REST source sublist, SuiteQL kitmemberof/stable keys, and current kit definitions by identity; never match names or guesses. Same SKU in separate kits stays separate. Ordinary orders keep their stored-line fast path.
3. All members must represent the same positive whole-kit count. Allow fewer complete kits than ordered. Reject missing members, fractional or unequal kit counts, over-fulfillment, stale identities/definitions, conflicting locations, and malformed or ambiguous mappings before any POST.
4. Support single-level inventory/noninventory kits with one inventory location per kit. Reject nested kits and unsupported bin/lot/serial/inventory-detail requirements with a clear refresh/support error.
5. Re-read authoritative kit evidence immediately before a new POST, including remaining quantity. Recover an already-created matching IF before freshness checks; never POST twice after an ambiguous result. Verify returned IF parent identities, quantities, and locations.
6. Physical local finalization continues to use component confirmations exactly once. Kit parent quantity must not be counted again. Keep existing duplicate recovery, source claims, policy gates, delivery driver ownership, reservations, mixed-location splitting, photos, and all ordinary-order behavior.
7. No schema migration, new API endpoint, NetSuite item/account changes, rewriting failed commands, or automatic retry of SOB120656. No frontend flow change.
8. Test exact regression, several members and ratios, complete partial kits, missing/mismatched members, repeated SKUs, mixed ordinary/kit orders, changed definitions, location and remaining conflicts, timeout/duplicate recovery, and durable finalization once.
9. Deploy only this scoped patch on the current running display-fix image after checks. Validate candidate and deployed app with read-only production/NetSuite queries and inspect the corrected draft payload. Leave the actual fulfillment retry to the operator.

## Failure model and evidence

Wrong static-sublist line → source contract and SOB regression. Wrong quantity/duplicate member/SKU → exact identity and bidirectional property invariants. Changed definition/location/prior fulfillment → pre-POST read validation. Duplicate IF after timeout or retry → service and durable integration tests. Double local stock/load → repository/finalizer once tests. Unrelated worktree changes → pre-task snapshot, scoped diff on exact live image, file hashes and rollback. Existing suite failures → fresh baseline and zero-new-failure comparison.

## Setup

Use existing Docker Node20 test images, fast-check, c8, TypeScript and ESLint. No new dependencies or checkpoint commits. Preserve the dirty worktree through a source snapshot and hashes. Add focused tests, property/manual-mutation tests, one reproducible gauntlet, a scoped deployment script, and evidence. Use isolated ephemeral PostgreSQL for integration tests. Production reads remain read-only; actual NetSuite POST is excluded from validation.

## Clarification from finalization review

A completed pickup counts only physical pickable lines when calculating remaining stock. A kit parent must not keep SOB120656 in `partial_loaded` after its pallet and sand are loaded. Fulfilling two complete kits out of three must remain `partial_loaded` with one kit's physical components outstanding. This makes criterion 6's component-only finalization explicit.

The completion-status adjustment is scoped to excluding kit parents; the behavior of all other line types remains unchanged.
