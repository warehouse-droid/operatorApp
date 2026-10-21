# Special Item dispatch planning — 2026-10-09

The user authorized removing the remaining server restriction and specifically
requires Save to apply the plan without the Special Item stock/transport error.
Spec approval: not obtained (autonomous run); this records the interpretation of
the authorized request for review after implementation.

## Acceptance criteria

1. An active Special Item case with an approved PO can be assigned and saved
   with Vendor Pickup, Yard Pickup, or MBT Delivery, regardless of whether an
   accepted line is In Stock, Low Inventory, or waiting for production.
2. Manual Save Now and autosave return HTTP 200 and persist the candidate in
   the active plan. They do not return SPECIAL_STOCK_NOT_READY, applied=false,
   validationIssues, or a recoveryDraft for stock or fulfillment method.
3. Incremental planner commands and snapshot restore use the same policy.
4. PO approval, pending fulfillment changes, closure, pending quantity review,
   Attention, and post-PO review protections retain their existing error codes.
   Failed validation retains recovery behavior and does not partially apply.
5. General dispatch validation, edit leases, revision fences, and driver/truck
   assignment rules remain effective. Planning does not change stock readiness,
   fulfillment method, receipt status, or the physical collection requirements.
6. Split PO and grouped SO references follow the same planning policy.

## Failure model and setup

- A frontend-only workaround would leave Save rejected: test the actual HTTP
  PUT and incremental-command routes and reread the active snapshot.
- An overly broad bypass could ignore approval or closure: retain guard tests
  and existing closure/approval race tests.
- An incorrect response could silently preserve only a recovery draft: assert
  HTTP 200, the active order, and zero newly created save_recovery snapshots.
- Concurrent changes could be overwritten during release: overlay only the
  changed repository file onto the current live image, check source hashes and
  configuration, retain the previous image, and roll back on failed health.
- Tests run in the standard isolated Compose project with mbbs-tests.slice and
  bounded memory, CPU, PID and tmpfs settings. Register teardown before startup;
  remove containers, volumes, and networks and check production health.
- Use existing Node, PostgreSQL, fast-check, c8, ESLint and TypeScript tools.
  Add regression tests, a reproducible check runner, and an evidence report.
  No dependencies, database migrations, checkpoint commits, or production
  business-data edits are required.
