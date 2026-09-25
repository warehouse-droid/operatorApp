# Packed sales-order groups: acceptance specification

Scope: every sales-order group, with no order-reference exceptions. Tier 2 bug
fix to the dispatch projection; authoritative reconciliation and packing writes
remain unchanged. Spec approval: not obtained (autonomous run). The user asked
for the general fix after reviewing the cause.

## Behaviors

1. A packed, unfulfilled SO without an active preparation lock remains Queued
   when grouped, even with confirmed lines and nonzero packed quantities.
2. Reloading an old group carrying that false review recomputes its status from
   current children. Repeated reads are identical; source headers, source lines,
   saved plan revisions, quantities, members and route structure stay intact.
3. Saving/refreshing the normal group projection publishes the corrected status
   to both the global group and the order-pool card.
4. Genuine stored review/missing/error states still block packed groups, with
   the recorded reason retained.
5. Preparing orders, active preparation locks (including inconsistent packed
   plus locked rows), and unfinished line progress on open orders still trigger
   the existing draft protection. Loaded/fulfilled orders retain their bypass.
6. Authoritative SO reconciliation still refuses to overwrite any active or
   packed draft. This change only distinguishes completed packing for dispatch.
7. Mixed completed/packed groups retain Partially Done; fully completed groups
   retain Completed. The fix preserves nested-group and PO/TO behavior.

## Failure model and checks

- Accidentally clearing real review: database cases for review/missing/error.
- Losing packed work or changing a route: exact before/after database and plan
  assertions, real repository execution, rollback-isolated fixtures.
- Reintroducing the warning after save: global-group/card persistence check.
- Disabling draft safety: preparation/lock tests plus existing reconciliation
  integration harnesses and deliberate condition mutants.
- Unrelated regressions: full suite against baseline, adjacent group/planning
  tests, lint/type checks and source hash verification.

## Setup

Use existing Docker Node/PostgreSQL test images and installed npm dependencies.
Tests use a disposable internal network/database, never production credentials.
Add a regression test, repeatable runner/check script and evidence report. No
new dependencies, schema changes, NetSuite calls, or automatic commits. Preserve
all existing worktree changes. Review the final source diff for capabilities and
secrets; record skipped layers and any pre-existing failures explicitly.

## Addendum: existing cached cards

Live inspection found five active SO group cards carrying the same draft-only
warning. Refresh their derived review fields using the corrected plan read.
Preserve all other cached fields, source orders/lines, plan snapshots and audit
history. Retain any group that still has a real review or no matching current
group; repeat execution must be a no-op. Test the refresh in a rollback-isolated
database before production use and save a private before snapshot at release.
