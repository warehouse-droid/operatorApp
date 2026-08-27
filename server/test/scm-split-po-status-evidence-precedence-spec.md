# Split PO operational-status evidence precedence

Status: implementation contract (2026-08-27)

Approval record: explicit line-by-line specification approval was not obtained.
The user explicitly requested a systemic prevention fix after identifying the
two production witnesses below, so this is an autonomous Tier 3 data-integrity
repair. Production remains read-only until a separately authorized deployment.

## Production witnesses

- `3022069120` belongs to source PO `POB03535`. Its saved schedule status is
  `Completed`, but a later reconciliation redistributed same-yard source
  receipts and calculated only `963.4 / 2323.2` as inferred. That attempted to
  regress the child to review/partial even though the operational status was
  already terminal.
- `SN1397956` belongs to source PO `POB03658`. It is actively planned for
  2026-08-27 and has no child receipt, Driver completion, or other exact local
  progress. Reconciliation assigned `571.2 / 2147.6` from an ambiguous
  same-yard source receipt and incorrectly promoted it to `Partially Done`.
- `TOB00960` is not a defect: linked SO `SOA06859` is not completed, so the TO
  must not be projected as completed. It is retained as a negative scope guard.

## Required invariants

1. Reconciliation may retain inferred split-child quantities for audit and
   display, including their `inferred` evidence label.
2. An inferred-only quantity greater than zero but below the child quantity is
   not operational proof. It cannot promote a split PO or split TO from a
   queue/planning state to `Partially Done` or `In Transit`.
3. An inferred-only partial target with active plan evidence resolves to
   `Planned`. Without active plan evidence it retains a valid non-progress
   schedule state, or falls back to `Queued` if its previous state was itself a
   reconciliation progress/review state.
4. Exact child evidence and administrator-pinned allocation remain allowed to
   produce `Partially Done` or `In Transit`.
5. A fully allocated child may retain the existing `Completed` calculation,
   even when allocation within one yard is inferred. This preserves the
   established split-PO conservation rule.
6. Once a split child is `Completed`, a later inferred-only redistribution
   cannot downgrade it or open the specific "lost destination receipt
   evidence" review. Terminal status is monotonic unless an explicit supported
   reopen/cancellation workflow changes it.
7. Genuine family conflicts, wrong-yard overflow, line-identity failures,
   explicit review reasons, and NetSuite closed/cancelled lifecycle rules keep
   their existing fail-closed behavior. This policy cannot hide those reviews.
8. Reconciliation is deterministic and idempotent. Reordering equivalent
   inferred inputs or replaying a run cannot change the operational result.
9. Schedule persistence and schedule reads use the same evidence-precedence
   rule; the PO Split and PO/TO Schedule screens cannot disagree.
10. The change does not alter receipt allocation quantities, split ledgers,
    NetSuite data, Driver jobs, Dispatch plans/snapshots, dependency modes, or
    Driver PWA behavior.
11. An incomplete linked SO cannot complete its linked TO. `TOB00960` remains
    non-completed until the existing fully-covered linked-delivery completion
    contract is satisfied.

## Failure modes to prove

- ambiguous same-yard source receipt falsely promotes a planned child;
- a later split/receipt reorders inferred capacity and regresses Completed;
- mixed exact/inferred evidence is incorrectly treated as wholly unproven;
- inferred full allocation is accidentally prevented from completing;
- a genuine family-level conflict is hidden by target-level stabilization;
- accepted/replayed reconciliation oscillates between Planned and Partial;
- PO Split and PO/TO Schedule derive different statuses;
- the unrelated linked-TO completion rule is weakened.

## Verification contract

- RED-first pure unit tests for `3022069120` and `SN1397956` semantics;
- randomized property tests for monotonic completion, inferred partial safety,
  exact/pinned progress, determinism, and idempotence;
- rollback-only PostgreSQL repository reproduction of a planned inferred child
  and a previously completed inferred child;
- adversarial controls for family review, cancelled/closed state, mixed
  evidence, zero/full/fractional quantities, and stale schedule timestamps;
- existing split allocation, reconciliation, PO Split UI, PO/TO Schedule,
  authoritative status, dependency, and Driver completion tests;
- focused coverage, lint, type check, manual mutation testing, source-state and
  secret scans; no new dependency is permitted.

## Repair/deployment boundary

The implementation may prepare an idempotent targeted replay for `POB03535`
and `POB03658`, but it must not mutate production or deploy without a separate
explicit user request.

## Addendum: universal local-completion precedence

After the initial contract was recorded, the user clarified that genuine local
status must override NetSuite status. Read-only production verification found:

- all 89 yard-replenishment dependencies whose local dependency status is
  `delivered` already have a universal completion event;
- all four `direct_to_customer` dependencies at `received_local` have a
  universal completion event;
- `TOB00960` has no order-completion event and no completed linked SO/group. Its
  only completed local record is Driver pickup job `1860`; the schedule remains
  `Planned` and dependency `221` remains `active`.

Accordingly, the precedence contract is refined as follows without weakening
the Driver sequence:

12. Any genuine event in `dispatch_order_completion_status` is authoritative
    local completion and must display `Completed` ahead of a later NetSuite
    reconciliation/review, regardless of whether its evidence type is
    `driver_job`, `direct_dependency`, `manual_dispatch`, `reconciliation`,
    `vrma_completion`, or `custom_order`.
13. A completed pickup stop alone is not an order completion. It can support
    pickup/in-transit progress but cannot complete a TO before its required
    destination or linked-customer completion evidence exists.
14. NetSuite-derived/inferred reconciliation is not local operational evidence
    and therefore cannot claim the local-precedence rule.
