# Sales Order Re-attempt Current-item Correction — Executable Specification

Status: **approved for isolated implementation and verification**

Evidence tier: **3** — this change affects completed Driver evidence, order-line
identity, concurrency, and operational sequencing.

## Confirmed production case

- Parent Sales Order `SOM05681` is local NetSuite ID `945867`.
- Parent line `4760329` currently identifies item `3632`,
  `UNI-WIN70T-RDM-GN`, quantity `1470.08 SQFT` / `16 PLT`.
- The immutable first-attempt load evidence identifies item `3631`,
  `UNI-WIN70T-RDM-CG`.
- Re-attempt `SOM05681-R1` already records both identities, but incorrectly
  uses historical `CG` as its operational line and only stores `GN` as
  `currentSku` metadata.
- The user confirmed that the physical second attempt delivered `GN`.
- Sety completed the R1 Driver pickup and drop-off on 2026-08-15. Those Driver
  rows, timestamps, photos, and completion events are immutable evidence.
- R1 has no Operator re-load record and cycle 2 is still `authorized`, even
  though its child is `completed`. This is retained as an explicit sequence
  anomaly; the repair must never invent an Operator load record.

## Failure model

1. Rewriting the historical CG evidence makes the first attempt falsely appear
   to have carried GN.
2. Rewriting a completed Driver row, plan snapshot, timestamp, photo, or
   completion event destroys immutable operational evidence.
3. A normal parent sync silently changes an in-progress child while a driver is
   carrying freight.
4. A stale or ambiguous NetSuite line mapping applies the wrong item.
5. Two administrators race and create conflicting effective-item corrections.
6. A retry creates duplicate correction rows or applies a correction twice.
7. Correcting the display accidentally makes the linked re-attempt independently
   billable or changes inventory/reservations.
8. Driver can execute a future re-attempt before Operator has completed the
   authorized re-load.
9. Repairing the existing sequence anomaly fabricates missing Operator evidence.
10. One screen shows GN while another screen still instructs staff to handle CG.

## Setup and authorization boundary

- Add no dependency and do not change package lockfiles.
- Use the existing PostgreSQL, Node test, Playwright, lint, typecheck, coverage,
  and mutation infrastructure.
- All development and verification use isolated disposable containers and
  synthetic/SOM05681-shaped fixtures.
- Preserve the dirty `codex/dockerVer` worktree and do not create commits.
- Do not deploy, call NetSuite, or mutate production during implementation or
  verification.
- Deployment and the one-time production correction require separate explicit
  authorization after the evidence report.

## Required model

- Historical identity remains immutable on the reload cycle line and original
  load evidence: historical item/SKU `CG` remains visible forever.
- Operational identity for a re-attempt is the latest authoritative current
  NetSuite line selected at authorization: item/SKU `GN` for this case.
- A completed correction is an append-only overlay. It does not update or delete
  raw Driver evidence, original load evidence, completion events, or historical
  Dispatch snapshots.
- Every correction records child, cycle, parent, NetSuite line, before identity,
  after identity, reason, actor, idempotency key, expected state, and timestamp.
- A superseding correction may be appended; a correction row cannot be updated
  or deleted.
- The effective projection used by current UI/API consumers applies the latest
  correction and visibly labels both `Effective/current item` and
  `Historical first-attempt item`.

## Executable scenarios

### 1. New re-attempt uses the current item

Given an immutable original load of 16 PLT `CG`
and the refreshed parent line with the same NetSuite line ID is 16 PLT `GN`
when an administrator authorizes a re-attempt
then the new child operational fields use item `3632` / SKU `GN`
and the cycle retains item `3631` / SKU `CG` in historical fields
and the UI displays the mismatch and both identities.

### 2. Parent sync alone does not rewrite a child

Given an existing re-attempt child
when `SOM05681` is synchronized from NetSuite
then only the parent projection is refreshed
and the child changes only through the explicit re-attempt reconciliation
command.

### 3. Unstarted child can be reconciled safely

Given a child is open, its cycle is authorized, it has no Operator/Driver
activity, and it is absent from active plans
when an administrator previews and confirms reconciliation
then the child operational snapshot is rebased to the current mapped parent
line in one transaction
and historical evidence remains unchanged.

If the child is planned, Operator activity exists, Driver activity exists, or
the expected revision/current-line fingerprint is stale, reconciliation fails
without mutation.

### 4. Completed child requires an append-only correction

Given a completed child and immutable Driver evidence
when an administrator confirms the physically delivered current item with a
non-blank reason and expected-state fingerprint
then one immutable correction overlay is appended
and no raw completed evidence is changed.

The exact idempotency retry returns the first result. Reuse of that key for a
different child, line, or identity fails.

### 5. SOM05681-R1 projects GN without erasing CG

Given the confirmed production-shaped fixture
when the completed correction is applied
then current Dispatch, Control, Driver-history, and order-detail projections
show effective item `UNI-WIN70T-RDM-GN`, 16 PLT, 1470.08 SQFT
and show historical first-attempt item `UNI-WIN70T-RDM-CG`
and retain Sety's original pickup/drop-off timestamps and completion evidence.

### 6. Sequence anomaly is explicit, never fabricated

Given R1 has completed Driver evidence but no Operator load record
when the correction is applied
then no `operator_load_records` row is inserted
and the cycle becomes terminal through an audited
`driver_completion_reconciliation` source
and UI/API output warns that Operator load evidence is absent.

### 7. Future Driver readiness is fail-closed

Given a planned Sales Order re-attempt whose cycle lacks a completed Operator
load
when Driver loads the route or submits an online/offline pickup/drop-off event
then the re-attempt is not executable and the server rejects or quarantines the
event with a stable readiness code.

After the matching Operator load completes the cycle, Driver execution becomes
available without changing the Dispatch plan or creating a new PWA version.

### 8. No billing, stock, or parent side effects

Applying or projecting a re-attempt correction must not:

- create a billing candidate for the child;
- change `linked_parent_no_charge`;
- change inventory, allocation, reservation, return, or stock-request rows;
- change the original Sales Order quantities, completion, group, or load rows;
- call a NetSuite write endpoint.

### 9. Authorization and input safety

- Preview and apply endpoints require Admin/Control authority.
- The current parent line must be active and map uniquely by NetSuite line ID.
- Blank reasons, unknown children, ordinary Custom Orders, cross-parent lines,
  non-finite quantities, quantity drift, stale fingerprints, and malformed
  idempotency keys fail without mutation.
- A correction cannot change quantity; quantity remains the authorized 16 PLT /
  1470.08 SQFT in this case.

## Required verification

- Observe RED failures for new-child current identity, completed correction,
  idempotency/race safety, projections, and Driver readiness before production
  implementation changes.
- Unit and property tests for identity selection, fingerprints, invalid input,
  and historical/effective invariants.
- PostgreSQL integration tests for append-only enforcement, atomicity,
  concurrency, no-side-effect table snapshots, and the exact SOM05681 shape.
- HTTP authorization and stale-request contract tests.
- Browser coverage for the confirmation UI and historical/effective labels on
  desktop Chromium, mobile Chromium, and mobile WebKit.
- Focused changed-line coverage plus mutation testing that flips current versus
  historical identity, removes immutability, bypasses readiness, and drops the
  no-charge invariant.
- Full applicable regression, typecheck, lint, syntax, secret scan, and a
  production-shaped dry-run of the one-time repair command.

## Approval record

- Approved by the user on 2026-08-25 after confirming that the physical second
  attempt for `SOM05681-R1` delivered `UNI-WIN70T-RDM-GN`.
- Approval authorizes implementation and isolated verification of this
  specification. Deployment and the production correction remain separately
  gated as stated above.
