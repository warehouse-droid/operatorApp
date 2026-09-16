# Split dependency guard

## Incident and scope

The September 15 recovery snapshots for plan 327 contain SOA08716-S1/S2,
replacing the saved SOA08716. Dependency 242 links SOA08716 to TOB01086 in
direct-to-customer mode. The first split audit is at 15:54:27 UTC; subsequent
recovery drafts retain that rejected split. SOA08748 has no matching dependency.
The browser currently allows the invalid split into its local draft, so later
saves encounter the earlier violation again.

Use old-coder Tier 2 for this browser validation bug. Spec approval: not obtained
(autonomous run). Existing server dependency, execution, and recovery rules remain
authoritative. Do not unlink dependencies or rewrite any live plans.

## Acceptance criteria

1. A non-cancelled direct dependency on SOA08716 → TOB01086 blocks its split
   dialog and identifies the linked orders.
2. Calling the split operation itself rechecks the guard before modifying orders
   or quantities, including when a dependency appears after the dialog opened.
3. After a blocked SOA08716 split, splitting unrelated SOA08748 yields only
   SOA08748-S1/S2 and leaves SOA08716 unchanged in the save payload.
4. A dependency on a nested group member blocks splitting that group. Unknown
   non-cancelled dependency modes fail closed, matching the server policy.
5. Yard-replenishment dependencies and cancelled direct dependencies remain
   splittable. Existing packed/loaded restrictions still apply.
6. Unrelated order dependencies cannot block the target. Allowed splits preserve
   total item quantities and record local plan ownership.

## Setup and verification

Use existing Docker test images, Node test runner, fast-check, c8, ESLint and
TypeScript. No package installation, database setup, migration, or git commits.
Save a task baseline of the already modified browser file. Add focused browser
tests, a reproducible runner, mutation checks and an evidence report. Run focused
RED/GREEN tests, the complete Dispatch frontend suite against baseline and final
source, existing split/save harnesses, syntax/static checks, changed-line coverage,
manual mutations and a browser execution of the production functions. Record
pre-existing failures and any skipped layer explicitly.

## Corrected scope after the user's clarification

The user did not split SOA08716: they selected SOA08748. They have now completed
the intended split by refreshing and reselecting and asked to fix the concrete
frontend bug as well. The initial acceptance criteria above are superseded;
no implementation of the proposed dependency guard was made.

The concrete defect is `showOrderTooltip` assigning the hovered order to
`selectedOrderId`. That silently changes the target used by
`renderSelectedOrderActions` on the next render. It also disagrees with the
unchanged `selectedOrderIds` set.

Final acceptance criteria:

1. Select SOA08748, then hover SOA08716: show SOA08716's tooltip while keeping
   SOA08748 selected and keeping its Split button targeted at SOA08748.
2. Refresh the order action controls after that hover, then create the split:
   only SOA08748-S1/S2 are created. SOA08716 and its TOB01086 dependency are
   unchanged in the submitted plan.
3. Hover does not change any explicit multi-selection or create a selection
   where there was none. Clicking another order still selects it normally.
4. Repeated hover sequences, including unknown/missing order cards, preserve
   selection. Tooltip content still matches the hovered order.
5. Keep all server dependency and split rules unchanged. No live plan repair is
   needed because the user has already completed the split.

The implementation is the removal of the hover-time selection assignment.
Run the complete frontend suite, existing tooltip/split/save harnesses, a real
Chromium split workflow, focused property tests, three deliberate mutations,
syntax and scoped lint checks. Browser JavaScript is outside the project's
TypeScript configuration; document that limit. No new dependencies.
