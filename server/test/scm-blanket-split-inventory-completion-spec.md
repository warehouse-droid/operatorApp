# Blanket split expected-inventory and PO Split completion specification

Status: implementation contract

Approval: not obtained (autonomous run). The user supplied the production
examples and requested investigation plus a fix; this contract narrows the
change to inventory projection and read-only status presentation.

## Production evidence to preserve

- `POB03669` is an active Blanket PO at yard 3445.
- Source line `127426` contains 66 PLT / 594 sales units of item `1158`.
- Active child `SN1399039` contains 22 PLT / 198 sales units, also destined for
  3445. It is not Driver-completed as of the investigation.
- Active sibling `SN1398130` contains 22 PLT / 198 sales units destined for
  12441.
- NetSuite's authoritative item-1158 on-order balance at 3445 is 495 sales
  units. The current calculation excludes 594 Blanket units and reports 0 PLT
  because the same-yard child is discarded before calculation.
- Completed split examples have exact `dispatch_order_completion_status`
  evidence while their `scm_transport_schedule.status` remains `Planned`.

## Invariants

1. An active local split of a Blanket PO is real inbound supply at its child
   destination, including when source and destination are the same yard.
2. Blanket source quantity remains excluded. A released child is added after
   that exclusion, so it cannot be swallowed by `max(0, authoritative -
   Blanket)` and cannot be counted twice.
3. A normal non-Blanket split continues to move its remaining quantity from
   the source yard to the child destination exactly once.
4. Cancelled, inactive, closed, fully received, or zero-remaining children add
   no expected inventory.
5. A PO Split row displays `Completed` only when canonical completed evidence
   matches that row's own PO reference case-insensitively.
6. Completion of a source PO, sibling split, grouped peer, pickup-only Driver
   stop, or unrelated alias must not mark another split completed.
7. This change does not alter Driver jobs, receiving quantities, NetSuite
   records, split quantities, schedules, or Dispatch plans.

## Executable scenarios

### Same-yard Blanket release

Given authoritative on-order is 495 sales units, Blanket exclusion is 594,
and active same-yard child inbound is 198,
when expected inventory is calculated with 9 sales units per pallet,
then effective on-order is 198 and expected inventory is 22 PLT (before AA and
BO adjustments), not 0 or 11 PLT.

### Cross-yard Blanket release

An active Blanket child from 3445 to 12441 adds its remaining quantity at
12441 without subtracting the already-excluded Blanket source a second time.

### Ordinary split

An active non-Blanket child still subtracts its remaining quantity at the
source and adds the same quantity at the destination; total authoritative
inbound remains conserved.

### Terminal split

An inactive, cancelled, closed, fully received, or zero-remaining split makes
no projection.

### Exact completion presentation

Given sibling split A has canonical `completed` evidence and sibling split B
has only a `Planned` schedule, PO Split shows A as `Completed` and leaves B as
`Planned`. A completed pickup record without canonical final completion does
not qualify.

## Failure model and oracle

| Failure | Test oracle |
| --- | --- |
| Same-yard child silently disappears | pure projection test requires protected inbound delta |
| Child is reduced by the Blanket exclusion | inventory formula test requires 198 effective units |
| Blanket child is double-counted | formula and repository fixture require exactly one child quantity |
| Ordinary split stops moving supply | existing conservation test remains green |
| Terminal child inflates supply | terminal matrix remains zero |
| Completed sibling contaminates another row | repository integration test asserts exact-ref isolation |
| UI continues to show Planned | frontend contract asserts Completed status/badge rendering |

## Verification and scope

- Run focused unit, frontend, and PostgreSQL integration tests in an isolated
  disposable test stack.
- Run the existing Smart SCM phased-planning and PO Split regression suites.
- Run lint/type checks scoped to touched files when available.
- Tear down the disposable test containers, volumes, and locally built test
  image after evidence is collected.
- Do not deploy or mutate production data in this task.
