# PO Split discovery and PO/TO status consistency specification

Status: autonomous repair requested on 2026-08-28.

Spec approval: not obtained before implementation. The user explicitly requested
that the defect be reproduced by a failing test before production code changes;
this document and the RED tests are therefore created first and implementation
must remain untouched until the RED result is recorded.

## Outcomes

1. **Every database PO except Pending Approval is discoverable in PO Split.**
   A purchase order is Pending Approval when its NetSuite status code is `A` or
   its normalized status text is `Pending Approval` / `Pending Supervisor
   Approval`, with or without the `Purchase Order:` prefix. No other lifecycle
   status is excluded from the indexed PO Split catalog merely because it is
   old, inactive, fully received, billed, cancelled, rejected, or closed.
   Existing write-side closed-order and quantity guards remain authoritative, so
   discovery does not make an ineligible order editable.
2. **Discovery is not capped by the UI page size.** The initial response remains
   bounded to 200 summary cards, while an indexed search can find every eligible
   PO even when more than 500 eligible POs exist.
3. **PO Split never presents a stale saved schedule status.** If the indexed
   catalog says `Queued` and the authoritative schedule row is later saved as
   `Hold`, both the PO Split list card and hydrated detail return `Hold` without
   waiting for a background catalog rebuild.
4. **Status precedence stays shared with PO/TO Schedule.** Canonical completion,
   blocking reconciliation review, and timestamp precedence retain their
   existing rules. PO Split and PO/TO Schedule must agree for the same PO; PO and
   TO schedule rows must both expose the latest saved manual `Hold` state.

## Failure model

- A bounded full-catalog refresh silently indexes only the newest 500 POs.
- Pending Approval is recognized by text but missed when NetSuite supplies only
  status code `A`, or `Pending Supervisor Approval` spelling.
- A background read-model refresh is delayed, failed, or coalesced, leaving a
  user-saved `Hold` displayed as the old `Queued` value.
- A live overlay incorrectly regresses terminal `Completed` or blocking
  `Reconcile Review` evidence.
- Making historical POs searchable accidentally bypasses existing write guards.
- Fixing PO Split status creates a PO/TO Schedule regression or an unbounded
  initial HTTP response.

## Executable scenarios

1. Given 501 non-Pending-Approval POs, when the PO Split catalog is rebuilt and
   the oldest PO is searched, then it is returned even though the first page is
   still at most 200 cards.
2. Given POs with code `A`, `Pending Approval`, and `Pending Supervisor
   Approval`, when the catalog is rebuilt, then none is returned; otherwise
   equivalent Pending Receipt, billed, cancelled, rejected, closed, fully
   received, and inactive rows remain searchable.
3. Given a PO catalog snapshot with `Queued`, when its saved schedule changes to
   `Hold`, then catalog list and detail reads return `Hold` and match the
   PO/TO Schedule effective status.
4. Given terminal completion or blocking reconciliation evidence, when a stale
   catalog or newer non-terminal schedule value exists, then the established
   terminal/review precedence remains unchanged.
5. Given PO and TO schedule rows saved as `Hold`, when the combined schedule is
   read and status-filtered, then both rows return and display `Hold`.
6. Given a discovered closed/inactive PO, when a split mutation is attempted,
   then the existing closed-order/editability guard still rejects it.

## Invariants and setup

- No production data is mutated during diagnosis. Database witnesses are
  aggregate/read-only; automated mutations use the isolated test database and
  rollback or truncation fixtures.
- Public response shapes and existing status labels remain compatible.
- Initial PO Split payloads contain summaries only and at most 200 cards.
- Existing schedule-status, reconciliation, split-editing, closed-order, and
  application-workload performance suites must have zero new failures.
- No new runtime or development dependency is authorized or required.
- No commits are created; the existing dirty worktree is user-owned.

## Spec revision 1 — active-order boundary (2026-08-28)

The read-only database audit showed that inactive PO rows include locally retired
`SCM unsplit` and `SCM group cancelled` records. Re-indexing those rows would
resurrect deliberately removed PO Split artifacts. Therefore “every database PO”
is concretized as every **current active** `purchase_orders` row except Pending
Approval. Inactive rows remain excluded. Active closed/rejected rows may remain
discoverable for history, but all existing closed-order write guards continue to
reject split mutations. This revision supersedes the earlier inclusion of
inactive rows in Outcome 1.

Production witness `POB03782` is active, has NetSuite status `B / Purchase Order:
Pending Receipt`, initial SCM status `Hold`, and no schedule/split/group hiding
relationship, yet has no catalog entry. This proves the background audience
filter—not lifecycle eligibility—removed it.

## Spec revision 2 — linked status conflict (2026-08-28)

Production witness `PO# B03429 (L1)` has its own Queued schedule row and links
to source ref `POB03429`, whose authoritative schedule and shared
reconciliation target are Hold. PO Split must not stop at the first display-ref
row and show Queued. When one linked candidate resolves to Hold while the
initial display candidate resolves only to Queued or Planned, the effective PO
Split status is Hold. Existing Completed and Reconcile Review precedence remains
unchanged. The same anti-staleness rule applies when a newly created display
alias is absent from an older shared reconciliation snapshot but its linked
source has already advanced to another effective non-Queued/Planned state such
as Partially Done.

## Spec revision 3 — B03429 L1 historical completion (2026-08-28)

The user explicitly confirmed that `PO# B03429 (L1)` was completed by Driver
Dao on 2026-08-11 and requested a backend correction. The correction must use
the canonical audited manual-completion path, must not fabricate a Driver-PWA
job or photo, and must cause active PO/TO Schedule and PO Split projections to
prefer Completed over the conflicting Planned/Queued/Hold evidence. Because no
completion time was supplied, the audit must disclose the neutral noon
America/Toronto timestamp used to anchor the supplied date.

## Spec revision 4 — linked initial-status authority (2026-08-29)

After the first deployment, `POB03782` acquired the display ref
`LOINC-029735`. Its current PO mirror remained active, Pending Receipt, and
initial SCM `Hold`, while an automatically materialized schedule row for the
display ref was only `Queued`. Search still found the PO through its linked
identity, but list/detail status regressed to Queued because the live overlay
consulted schedules, reconciliation, and completion without consulting the
current source PO mirror.

For every catalog order, live status resolution must now look up the current
`purchase_orders.initial_scm_status` through every exact linked transaction or
display identity. When a display candidate is only Queued/Planned and an
unscheduled linked source is Hold, Hold wins. An explicit saved schedule status
continues to win for its exact identity; canonical completion, reconciliation
review, and timestamp precedence remain unchanged. Active/recent mirror rows
take precedence over retired reused identities. This rule is generic and must
not contain a production order or alias constant.
