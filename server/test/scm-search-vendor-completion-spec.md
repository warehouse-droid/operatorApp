# SCM search and local Vendor completion

Spec approval: not obtained (autonomous run). The user explicitly requested both
changes; implementation proceeds within that authorization. Tier 3 applies to
the new authenticated state-changing endpoint and concurrent completion clicks.

## Acceptance scenarios

1. A nonempty global SCM search returns matching Queued, Hold, Cancelled,
   Completed, and reconciliation-completed PO/TO rows regardless of the selected
   status or status-based view. Empty/whitespace searches retain normal default
   exclusions. Non-status column filters and existing role restrictions remain.
   This supersedes the older schedule-loading test's use of text search as an
   unfiltered active-list request. Native closed-family and group/split identity
   exclusions retain their existing behavior.
2. The real schedule client preserves search text, suppresses status restrictions
   during search, and displays the returned Completed result. Clearing search
   restores the selected status/view behavior.
3. SCM Working offers a Complete button on editable Vendor PO, TO, and VRMA rows
   to Admin, SCM, and SCM Staff users. Other methods, other views, cancelled rows,
   blocked review rows, and already operationally completed rows do not offer it.
4. Completion records immutable local evidence with the actor and timestamp,
   marks the schedule Completed, and remains Completed after refresh and later
   reconciliation. No plan, Driver job, receipt quantity, or NetSuite connectivity
   is required. NetSuite order headers and quantities remain unchanged.
5. The server verifies the saved Vendor method, actor role, order kind/ref,
   current revision, cancellation, and review block. Invalid requests make no
   writes. Repeated/concurrent completion produces one local completion event.
   A missing schedule or source order is rejected; client-supplied method/actor
   claims cannot bypass the saved state or authenticated identity.
6. A completion failure rolls back both status and evidence. No NetSuite request,
   fulfillment/receipt outbox, fake Driver job, or plan mutation is produced.
7. Existing schedule columns, remarks, filters without search, split handling,
   completion history, and access controls keep working.

## Failure model and checks

- Hidden search results: repository integration and real-browser tests.
- Forged method/role/ref and stale page: adversarial endpoint/repository tests.
- Duplicate or partial completion: concurrent requests, immutable evidence count,
  transaction failure/rollback check, and property checks for input normalization.
- Completion overwritten by reconciliation: canonical status and reconciliation
  projection replay after the saved schedule is changed.
- Accidental external posting: deny network in isolated tests, verify no posting
  outbox or Driver/plan writes, inspect capability diff and database triggers.
- UI mismatch: Chromium execution of the actual schedule script and button flow.

## Setup and evidence plan

Use existing Node, PostgreSQL, Playwright, fast-check, c8, TypeScript, and ESLint.
No dependencies or git commits. Preserve the existing dirty workspace; keep
task-start file hashes/copies for reviewing only this task's delta. Add one
additive migration permitting a distinct SCM Vendor completion evidence type,
one local repository/service, focused tests, a reproducible gauntlet/mutation
runner, and an evidence report. All fixtures and mutations run in a dedicated
isolated database/container with no production credentials or external network.
Run failing acceptance tests before implementation, then regression, static,
coverage, mutation, and browser checks. Report skipped layers and baseline
failures explicitly. Validate a concrete release and apply the additive migration
and app image only after verification; preserve a rollback image. Do not complete
any real order while testing or deploying.
