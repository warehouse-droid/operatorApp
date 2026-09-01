# Manual SCM PO split authority specification

Status: autonomous production repair requested on 2026-08-31.

Spec approval: not obtained before implementation. The user requested the fix
after confirming the desired operational state. This specification is written
before implementation, and the evidence report must record the reduced
confidence caused by autonomous approval.

## Outcomes

1. A user-created SCM PO split defaults to `Hold`. Its synthetic
   `purchase_orders.initial_scm_status` and `scm_transport_schedule.status`
   persist the same status atomically.
2. The destination confirmed in the split modal is authoritative. Split
   creation persists it in the split ledger, synthetic PO, and schedule; PO
   Split labels a legacy blank schedule value as `Split confirmation`, never
   `NetSuite`.
3. PO reconciliation may update quantities and the parent review state, but it
   never replaces an active manual split child's operational status or
   destination with derived `Queued`, `Partially Done`, `Completed`, or a
   family-wide `Reconcile Review` state.
4. A later explicit user, dispatch-plan, or driver completion remains
   authoritative. The new rule preserves the current operational status; it
   does not force every split to remain `Hold` forever.
5. The production repair is exact, transactional, auditable, and idempotent.
   It changes only the 37 active children of `POB03658`: operational and
   initial status become `Hold`, schedule destination becomes the destination
   stored by the split confirmation, and child-level reconciliation blocking
   is cleared. Quantities, receipts, allocations, dispatch plans, the parent
   status, and the open parent review case remain unchanged.

## Failure model

- Accepting a parent review loops over every target and mass-overwrites child
  statuses from the parent status.
- A scheduled reconciliation run recreates a missing child schedule as
  `Queued` or marks every child blocked by a parent-only conflict.
- A child status is preserved in the schedule but replaced by a calculated
  reconciliation status in PO Split or PO/TO Schedule.
- Split creation commits the ledger but omits status or destination from a
  mirror, producing conflicting sources of truth.
- A repair targets cancelled children, a similarly named PO, or only part of a
  family; a failure commits a partial update.
- Re-running the repair creates unnecessary writes or duplicate audit records.

## Executable scenarios

1. Given a source PO and a confirmed destination, creating a split without an
   explicit status writes `Hold` to both child status stores and writes the
   confirmed destination to all three routing stores.
2. Given a manual child saved as `Hold` and a reconciliation target with
   partial receipt progress, accepting the parent review leaves the child
   schedule `Hold`, clears its child block, and stores `Hold` in the target
   projection while the parent may remain quantity-derived.
3. Given a manual child with `Hold` plus newer reconciliation `Partially Done`
   or blocking parent review evidence, PO Split and PO/TO Schedule display
   `Hold`; given canonical local completion evidence, they display
   `Completed`.
4. Given a split whose schedule destination is blank, the PO Split control
   describes the effective destination as split-confirmed. A non-split PO
   retains the existing NetSuite label.
5. Given a fixture family with active and cancelled children, repair dry-run
   reports only active changes and rolls back; apply changes only active rows,
   emits one audit record per changed child, and a second apply reports zero
   changes.
6. Given an unexpected active-child count or missing/mismatched confirmed
   destination, repair aborts and commits no changes.

## Setup and invariants

- Tier 3 evidence-first loop: RED, GREEN, focused/full regressions, changed-line
  coverage, manual mutation, adversarial repair checks, and live read-back.
- No new dependencies or migrations.
- All automated database writes use the isolated test database and rollback
  fixtures until the explicitly requested production repair.
- The existing dirty worktree is user-owned. No unrelated file is reverted or
  included in the production overlay.
- Deployment uses the running production image as the base, overlays only the
  files named in the final evidence report, and uses a short container cutover.
- No commits are created.

## Revision 1: compatibility boundary

The regression suite showed that `Planned` has an existing, evidence-backed
lifecycle contract: an exactly received child becomes `Completed`, while
ambiguous partial evidence must not promote it. Outcome 3 therefore protects
operator-controlled split statuses (`Queued`, `Urgent`, `Cancelled`, `Hold`,
`Priority`, `Surplus Only`, and `Book Appt`), not the system-generated
`Planned` state. Reconciliation may continue to derive lifecycle progress from
`Planned`; accepting a parent review still may not mass-overwrite any existing
manual split schedule status. This revision was added before the compatibility
fix and supersedes only the broader wording in Outcome 3.

## Revision 2: constrained initial-status mirror

The existing `purchase_orders.initial_scm_status` constraint permits only
`Queued` and `Hold`; the shared schedule permits the full manual status set.
The synthetic child therefore stores the requested initial value when it is
`Queued` or `Hold`, and otherwise stores the safe `Hold` baseline while the
schedule stores the exact operator-selected value. The schedule remains the
authoritative editable status. This preserves existing `Priority`, `Urgent`,
and other manual split creation without a schema migration and refines Outcome
1 only for explicit non-`Hold`/non-`Queued` selections.

## Revision 3: exact split status outranks linked parent fallback

Production evidence after an accepted review showed a narrower projection
failure. An exact manual split schedule saved as `Queued` was treated as a weak
catalog result, so PO Split borrowed the linked parent's `Partially Done`
status. PO/TO Schedule retained the child's local status. For every active
manual split, an exact operator-controlled schedule status—including
`Queued`—must terminate linked-status fallback. Canonical completion evidence
still wins.

Executable regression: given an active manual child with an exact `Queued`
schedule and a linked parent reconciled as `Partially Done`, PO Split and
PO/TO Schedule both project `Queued`; after the child's exact status is
restored to `Hold`, both project `Hold`. A child without split identity retains
the existing linked-alias fallback behavior.

The follow-up production repair is restricted to the three exact affected
refs identified by read-only evidence (`SN1399496`, `SN1399520`, and
`SN1399548`). It must validate their active membership in POB03658, their
current `Queued` status, and their confirmed destination before atomically
restoring `Hold`; no other family member or business field may change.

## Revision 4: accepted conflict remains resolved for unchanged evidence

Case 311 reopened after the user selected **Accept current NetSuite outcome**
because the reconciliation case upsert unconditionally reset an existing case
to `open`. Acceptance is authoritative for the exact evidence the user
reviewed. A deterministic fingerprint covers the conflict reason and details,
source lifecycle and route, family quantities, split target quantities and
capacity, allocation quality, and line evidence. Reconciliation with the same
fingerprint must keep the case resolved, keep schedules unblocked, and project
the calculated non-review family state. A changed fingerprint must reopen the
same case for a new decision.

The fingerprint is stored with the case before acceptance and copied into the
resolution audit details. Existing open cases without a fingerprint receive
one on their next reconciliation or when accepted, so the change requires no
schema migration.

## Revision 5: preserve post-review planning and narrow the live repair

The pre-cutover guard found that `SN1399496` and `SN1399520` were placed onto
dispatch loads after the incident snapshot and autosaved as `Planned` at
21:25 UTC, later than case 311's 21:09 reconciliation snapshot. Accepting that
older review must preserve a split schedule status whose revision is newer
than the reviewed reconciliation evidence, including system-generated
`Planned`. The accepted target projection must use the same preserved status.

Those two refs are no longer repair candidates. The production data repair is
narrowed to `SN1399548`, which remains an active POB03658 child with exact
`Queued` status and a matching split-confirmed destination. The newer planned
rows and all other family members must remain unchanged.

## Revision 6: active dispatch planning remains authoritative across later reconciliation

The live current-evidence refresh proved that timestamp precedence alone is
insufficient. Once reconciliation records a newer snapshot, accepting that
review can replace an older but still-active `Planned` schedule with
`Partially Done`. An active dispatch assignment is continuing operational
evidence, not a one-time edit whose authority expires when reconciliation runs.

For an active manual PO split, `Planned` is authoritative while an exact active
dispatch assignment exists. Reconciliation may refresh quantities and the
parent conflict, but it must keep the child `Planned`, unblocked, and consistent
across PO Split and PO/TO Schedule. A stale `Planned` value without an active
assignment retains the existing evidence-derived lifecycle behavior. Canonical
driver completion still wins.

The corrective repair for `SN1399496` and `SN1399520` must require all of the
following in one transaction: exact POB03658 family membership, 38 active
children, current `Partially Done` schedule status, matching split-confirmed
destination, and an exact active dispatch assignment. It restores only those
two schedules to `Planned`, keeps the synthetic child baseline at `Hold`, and
emits one audit event per changed child.
