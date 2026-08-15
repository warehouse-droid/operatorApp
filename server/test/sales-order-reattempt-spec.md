# Sales Order Partial Re-attempt — Executable Specification

Evidence tier: **3** (completion evidence, physical quantities, concurrency, and billing).

Spec approval: **not obtained (autonomous run)**. The user supplied the workflow and
explicit invariants; the assumptions below make quantity and cancellation behavior
executable without pausing implementation.

## Setup and assumptions

- No new runtime or test dependency is required.
- The latest `operator_load_records` row for the Sales Order whose
  `reload_cycle_id IS NULL` is the immutable original-load quantity snapshot.
- A historical line maps to the refreshed current Sales Order first by NetSuite line
  ID, then by a unique item ID only when the line ID is unavailable. A missing mapping
  is displayed and cannot be selected; an item/SKU change on a mapped line is allowed
  only with a visible mismatch warning.
- Re-attempt inputs are captured in physical units (pallet/layer/section/piece) when
  conversions exist, with sales quantity retained as the exact canonical amount.
  For every unit, `already delivered = historical loaded - re-attempt`.
- A selected line requires its own non-blank reason. At least one line must have a
  positive re-attempt quantity.
- A completed original drop-off creates a `sales_order_reattempt` cycle and linked,
  system-managed Dispatch child. Legacy pre-drop-off re-load cycles remain compatible.
- A child may be cancelled only before Operator or driver activity and only after it
  is absent from every active Dispatch plan.

## Failure model

1. A cycle commits without its planner child, or the child commits without its cycle.
2. Concurrent/replayed authorization creates two `-R1` children or different results.
3. The client submits a stale load record, unknown line, negative/NaN quantity, or a
   quantity greater than the immutable historical load.
4. A changed SKU is silently replaced by the current SKU in the child payload.
5. An unselected line is re-loaded, or its already-delivered quantity is lost.
6. The child becomes a generic Custom Order with `LOAD`, zero pallets, or wrong weight.
7. Operator sees an unplanned child, or sees the original plan rather than the child's
   selected plan date/truck/load.
8. Authorization, planning, Operator loading, cancellation, or driver completion
   mutates the original SO progress, grouped stop, or immutable completion evidence.
9. Any path writes inventory, reservation, allocation, stock-return, or stock-request
   state.
10. The child produces a standalone MBBS billing candidate through custom, driver,
    universal-completion, or reconciliation fallback paths.
11. A planned/in-progress child is cancelled and remains executable in a Driver plan.
12. A malformed or cross-order selection links historical evidence from another SO.

## Scenarios

```gherkin
Feature: Completed Sales Order partial re-attempt

  Scenario: Preview compares immutable historical and refreshed current lines
    Given SOM05681's latest original load contains 16 pallets of UNI-WIN70T-RDM-CG
      and 3 pallets of UNI-WIN70S-0714-DC-2026
    And its refreshed current line at the same NetSuite line ID is UNI-WIN70T-RDM-GN
    When Control opens Authorize Re-load
    Then both originally loaded lines are returned
    And each line shows historical and current SKU, quantity, re-attempt, already delivered, and reason
    And the 16-pallet line is marked as an item/SKU mismatch

  Scenario: Selected 16-pallet line creates an atomic re-attempt pair
    Given the original grouped driver drop-off is complete
    When Control selects 16 pallets on the mismatched line, zero on the 3-pallet line,
      supplies a line reason, and authorizes request A
    Then one selected-quantity re-load cycle is created
    And one linked system-managed child SOM05681-R1 is created in the same transaction
    And the child is classified sales_order_reattempt with billing disposition linked_parent_no_charge
    And the selected line has 16 re-attempt pallets and zero already-delivered pallets
    And the unselected line has zero re-attempt pallets and 3 already-delivered pallets

  Scenario: Planner child retains real selected freight
    Given SOM05681-R1 exists
    When Dispatch lists the order pool
    Then it shows UNI-WIN70T-RDM-CG, 16 pallets, 1470.08 SQFT, retained item weight,
      pickup yard 12441, destination 77 Clarence St, and parent SOM05681
    And it is labelled Sales Order re-attempt rather than ordinary Custom Order

  Scenario: Planning child gates Operator availability
    Given SOM05681-R1 is authorized but unplanned
    Then Operator cannot see the re-attempt
    When Dispatch assigns it to plan date D, truck T, and load L
    Then Operator sees the linked re-load under exactly D, T, and L

  Scenario: Original completion and quantities remain immutable
    Given snapshots of SOM05681, both current lines, GOM-5681-5682, and its driver records
    When the re-attempt is authorized, planned, packed, and locally loaded
    Then every original snapshot is unchanged
    And the original grouped stop remains complete

  Scenario: Re-attempt has no stock or reservation side effects
    Given snapshots of inventory, reservations, allocations, stock returns, and stock requests
    When the re-attempt is authorized, planned, packed, and locally loaded
    Then every stock-related snapshot is unchanged

  Scenario: Linked child never creates duplicate billing
    Given SOM05681-R1 is completed by Driver
    When MBBS candidates are collected through every retained completion source
    Then no candidate references SOM05681-R1
    And the original SOM05681 billing identity is unchanged

  Scenario: Authorization replay is idempotent
    When request A is submitted twice for SOM05681
    Then both responses identify the same cycle and child
    And exactly one cycle and one SOM05681-R1 row exist

  Scenario: Concurrent authorization serializes child numbering
    When two different authorization requests race for the same completed SO
    Then at most one active cycle and one active child are committed
    And no half-created pair exists

  Scenario: Invalid quantities do not mutate state
    When Control submits negative, non-finite, fractional-over-limit, or all-zero selections
    Then authorization fails with a stable validation code
    And no cycle, child, audit event, inventory write, or original-order mutation occurs

  Scenario: Cross-order and stale evidence are rejected
    When a request names another order's load record or a superseded original-load record
    Then authorization fails with a stale-evidence conflict
    And no cycle or child is created

  Scenario: Selected-line reason is mandatory
    When a positive re-attempt quantity has a blank reason
    Then authorization fails with REATTEMPT_LINE_REASON_REQUIRED
    And no cycle or child is created

  Scenario: System-managed child cannot be edited as a Custom Order
    Given SOM05681-R1 exists
    When a user invokes ordinary Custom Order edit or cancel APIs
    Then the request is rejected as system-managed

  Scenario: Cancellation requires unplanning and cancels the pair atomically
    Given a re-attempt has no Operator or driver activity
    When its child is assigned to an active plan
    Then cancellation is rejected
    When Dispatch unplans the child and Control cancels it
    Then both cycle and child become cancelled in one transaction

  Scenario: Planning or cancellation cannot reopen the grouped original stop
    Given completed group GOM-5681-5682 contains SOM05681 and SOM05682
    When SOM05681-R1 is planned, unplanned, or cancelled
    Then the group, both original members, and original driver evidence are unchanged
```

## Required verification layers

- Unit policy tests for line mapping, quantity conservation, mismatch display, and validation.
- PostgreSQL integration tests for atomicity, immutable evidence, plan-to-Operator linkage,
  cancellation, and billing exclusion.
- Property tests over physical-unit quantities and adversarial malformed selections.
- Concurrency/idempotency test with independent database connections.
- Contract/UI tests for the Control dialog and Dispatch child projection.
- Manual mutation of the completed-drop-off exception, quantity upper bound, billing
  exclusion, and plan gate; every mutant must be killed.
- Fresh focused gauntlet plus the repository's full applicable suites and browser tests.
