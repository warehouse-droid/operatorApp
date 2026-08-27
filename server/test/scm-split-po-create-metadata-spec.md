# Split PO creation metadata

Status: implementation contract (2026-08-27)

Approval record: explicit line-by-line specification approval was not obtained;
the user explicitly requested this feature while the related PO Split work was
in progress. This remains inside the existing no-deploy boundary.

## Required behavior

1. The Create PO Ref summary modal contains an initial Status dropdown and a
   Remark textarea.
2. Status options are exactly the manually controlled SCM states already
   supported by PO/TO Schedule: `Queued`, `Urgent`, `Cancelled`, `Hold`,
   `Priority`, `Surplus Only`, and `Book Appt`. Driver/Dispatch-derived states
   (`Planned`, `Partially Done`, `In Transit`, `Completed`, and
   `Reconcile Review`) cannot be forged during creation.
3. The safe default is `Queued`; remark defaults empty and is limited to 2,000
   characters by the shared schedule-remark policy.
4. The client submits the live modal values, not stale render state.
5. Child PO, split header/lines, schedule status, and remark are committed in
   one database transaction. Invalid status or remark rolls the entire split
   back.
6. The initial remark is stored as `scm_transport_schedule.remark_override`, so
   PO Split and PO/TO Schedule read the same value without duplication.
7. Extending an existing Blanket split cannot reset its current status or
   remark to creation defaults.
8. Existing pickup-yard, destination-yard, quantity, locking, reconciliation,
   Dispatch planning, and Driver PWA behavior remains unchanged.

## Verification

- frontend VM contract proves controls, exact options, live-value submission,
  defaults, escaping, and reset after success/cancel;
- rollback-only repository test proves atomic persistence and invalid-input
  rollback;
- existing PO Split UI/integration, schedule remark, and schedule status suites
remain green;
- focused mutation, coverage, lint, type, source-state, and secret scans pass.
