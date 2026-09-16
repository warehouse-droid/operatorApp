# Blanket PO coverage automatically resumes earlier item holds

Spec approval: not obtained (autonomous run). The user explicitly requested the
general correction and automatic resumption of existing affected items.

## Behavior

1. Flagging an open source PO as Blanket retires an earlier active manual item
   hold when that PO has at least one usable whole pallet for the same item and
   the current planning conversion. The former hold remains in history.
2. Both Blanket calculation and ordinary planning reconcile existing Blanket
   coverage before loading policies, including POB03737's historical holds.
3. Every automatically retired hold records its item, exclusion, supporting PO
   references and source lines in an audit event. Repeated or concurrent
   requests produce only one retirement/audit per hold.
4. A hold entered after a PO was flagged stays active. Re-sending the same
   Blanket flag preserves the original flag timestamp. This is the default
   interpretation of “previous” holds; an optional user clarification is pending.
5. Ordinary, closed, inactive, exhausted, fully allocated/reserved, fractional
   and incompatible-conversion balances cannot resume an item. Other items and
   already inactive/expired holds retain their history.
6. A rollback restores the flag, hold and audit together. No vendor order,
   reservation, release or message is created by automatic resumption itself.
7. Existing FIFO allocation, whole-pallet packing, manual new holds, residual
   demand and authorization behavior remain intact.

## Failure model and checks

- Wrong item or unusable stock resumes a hold: database eligibility matrix and
  generated quantity/conversion cases.
- New operator decision is erased: timestamp and repeated-flag regression.
- Concurrent calculations duplicate history: real concurrent database calls.
- Partial write or audit failure: transaction rollback test.
- Cleared hold still omitted by the planner: actual Blanket and ordinary plan
  execution, plus real HTTP flag/hold-history checks.
- Broader regressions: existing Smart SCM and Blanket tests, baseline comparison.

## Setup and delivery

Use the existing Node 20, PostgreSQL, fast-check, ESLint and coverage tooling in
cached isolated Docker images; add no dependencies. Add task-specific tests,
scripts and evidence. Preserve the dirty worktree and identify tested source by
hash rather than create commits. Build a narrow image layer over the current
deployment, rehearse and apply the requested existing-hold reconciliation, then
verify POB03737's calculated proposals without reserving or sending them.

## User clarification — blanket coverage always wins

The user explicitly chose “Blanket coverage always overrides item holds.” This
supersedes behavior 4 and the “earlier” restriction throughout the original
criteria: hold and flag timestamps do not affect resumption. A new hold entered
while usable coverage exists is immediately retired, with the same history and
audit trail. The pause UI states this rule and accurately reports the outcome.
PO line synchronization also reconciles coverage after a flagged PO gains usable
quantity. Tests are updated before implementation to reflect this clarification.
