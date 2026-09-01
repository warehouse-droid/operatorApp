# SCM Reconcile Review Automation — Executable Specification

Status: implementation specification recorded autonomously from the operator's
request on 2026-08-29. It was not separately pre-approved, so the verification
evidence must retain that reduced-confidence note.

## Outcome

PO/TO reconciliation accepts authoritative, mechanically unambiguous NetSuite
changes without asking an operator to choose an outcome that the application
can already prove. A review quarantines only the affected order placement; it
does not block unrelated Dispatch Planning work.

## Production baseline (read-only)

At investigation time, production contained six open blocking TO review cases.
All six used `reconciliation_conflict` with the reason that a NetSuite quantity
decrease would alter a planned or operational split. None had an active TO split
ledger or a pinned allocation. Four (`TOB00989`, `TOB00994`, `TOB00995`, and
`TOB00996`) had no dispatch plan evidence at all: their only schedule was a
`Queued` row created by reconciliation. Two (`TOB00964` and `TOB00973`) had
historical plan/progress evidence, but were unsplit and their exact authoritative
progress did not exceed the amended quantity.

## Decision rules

1. The mere existence of `scm_transport_schedule` is not planning evidence.
   A TO is operationally planned only when its source header says it is planned,
   or its schedule has a real dispatch plan/ETA or an operational lifecycle
   status (`Planned`, `Partially Done`, `In Transit`, or `Completed`).
2. An exact quantity decrease on an unsplit source line is automatically
   accepted, including on an already planned TO, when progress remains within
   the new authoritative quantity.
3. A decrease that leaves every active split and pinned allocation within the
   new source capacity is automatically accepted; only the residual changes.
4. Review remains mandatory when authoritative data creates a real choice or
   unsafe state: changed operational locations; added, removed, replaced, or
   ambiguous line identity on an operational order; progress greater than the
   new ordered quantity; destination receipt greater than fulfillment; active
   split quantity greater than its source line; missing/cancelled pinned target;
   pinned quantity greater than target capacity; unexplained receipt location;
   or incomplete split identity/ledger.
5. Automatic application uses the existing transaction, durable audit event,
   review-case resolution, schedule projection, and idempotent upsert paths. It
   never posts an IF/IR or mutates NetSuite.
6. A blocking review prevents adding or moving that PO/TO in Dispatch. It does
   not block unrelated edits, metadata refreshes, regenerated pickup stops, or
   removal of the reviewed order from a plan.

## Failure model

| Failure | Executable protection |
| --- | --- |
| Reconciliation-created `Queued` row is mistaken for a plan | Repository integration regression and planning-evidence unit/property cases |
| Exact unsplit decrease is sent to review | Repository regression reproducing the production state transition |
| Unsafe split or progress overflow is auto-applied | Negative integration cases retain `review` with a specific reason |
| Location or line identity change after execution is hidden | Existing and new negative reconciliation cases |
| One reviewed order blocks an unrelated board save | Placement-diff unit regression and server wiring contract |
| Reviewed order can be newly placed or moved | Placement-diff negative cases and repository edit guard |
| Retry duplicates or regresses state | Apply-twice database regression and audit/state assertions |
| Stale evidence wins a race | Existing transaction, fingerprint, and run-lease tests remain mandatory |
| Review disappears without audit evidence | Review resolution/audit assertions and production post-cutover query |
| Broad query or diff causes planning latency regression | Existing Dispatch performance contracts and full suite |

## Required RED tests

- A local TO with only a reconciliation-created `Queued` schedule loads with
  `dispatchPlanned === false`.
- A prior reconciled TO whose exact unsplit quantity decreases proposes `ok`,
  not `Reconcile Review`, and apply-twice is stable.
- An active split exceeding the amended source quantity still proposes review.
- Dispatch placement diff returns no reviewed reference for an unrelated edit
  or source metadata refresh, but returns it for a new/moved placement.

## Verification gates

- Focused unit/integration tests first observed failing against the production
  implementation.
- Property cases vary schedule evidence, quantity direction, progress, split
  capacity, and unrelated plan mutations.
- Mutation checks kill removal/inversion of the planning-evidence and scoped
  placement guards.
- Existing reconciliation harness, Dispatch save contracts, lint/type gates,
  and the complete server test suite pass.
- Before production repair, take and validate a PostgreSQL backup. Deploy the
  app image with a short app-only cutover, rerun the affected order families
  through the normal reconciliation service, and verify review counts, schedule
  blocks, audit events, container health, and unrelated planning behavior.
