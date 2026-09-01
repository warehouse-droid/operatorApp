# PO Split live schedule parity specification

Status: autonomous repair requested on 2026-08-31.

Spec approval: not obtained before implementation. The user explicitly asked
for the reported failure to be reproduced before production code changes and
directed PO Split to use the more accurate PO/TO Schedule behavior. This
specification and its RED tests are therefore created before implementation.

## Outcomes

1. **PO Split uses the live SCM schedule as its schedule source of truth.** The
   indexed PO catalog remains the bounded search and quantity read model, but
   status, method, pickup, destination override, special-order flag, packing
   slip, group, ETA, driver, notes, remark, and optimistic revision come from
   the current `scm_transport_schedule` row, as PO/TO Schedule does.
   A linked source's initial status may fill a placeholder `Queued` alias, but
   it cannot downgrade an exact PO/TO Schedule result that has advanced to
   `Planned`. Canonical completion evidence remains monotonic.
   When persisted ETA, time, driver, or notes are blank, PO Split uses the same
   current Dispatch assignment fallback shown by PO/TO Schedule. Persisted
   schedule values retain precedence and derived display fallbacks are not
   added to the PO Split write payload.
2. **Detail hydration cannot regress a revision.** If a PO Split list card was
   read at revision A and its subsequently loaded detail contains revision B,
   where B is newer, Save submits B. If the card is newer, it remains
   authoritative. Related schedule fields are selected from the same winning
   state rather than mixed across revisions.
3. **Successful writes leave a monotonic revision.** A PO schedule save that
   also carries an unchanged Packing Slip / Ref cannot move `updated_at`
   backward to the transaction start time. The revision returned by a save and
   the revision subsequently read from the database identify the same committed
   state.
4. **True concurrent edits remain protected.** Two writers using one loaded
   revision cannot both commit. PO Split must not blindly retry a stale draft or
   weaken `SCM_SCHEDULE_STALE` checks.

## Failure model

- The persisted PO catalog can lag a Dispatch Planning or PO/TO Schedule write.
- A PO Split list request can finish before a concurrent schedule update while
  its detail request finishes after it; merging the old card over the new detail
  submits the old revision and creates a false stale rejection.
- Overlaying only status and `updatedAt` leaves method, routing, ETA, driver,
  notes, remark, and packing-slip values stale despite advertising a current
  revision.
- `updateScmScheduleEntry` advances with `clock_timestamp()`, then its nested PO
  reference synchronization writes `now()`. PostgreSQL fixes `now()` at the
  transaction start, so the nested write can regress the revision.
- Automatically accepting any stale write could overwrite a real Dispatch or
  SCM operator change.

## Executable scenarios

1. Given a catalog snapshot whose complete schedule fields are old, when the
   live schedule is changed, indexed list and detail reads return every current
   schedule field and exact current revision without a catalog rebuild.
2. Given a list card at revision A and hydrated detail at later revision B,
   when Save is clicked, the request carries B and the B schedule values.
3. Given hydrated detail at A and a later targeted card refresh at B, when Save
   is clicked, the request carries B.
4. Given a PO with a dispatch ref / packing slip, when a schedule patch includes
   that unchanged field, the committed revision is strictly newer than the
   loaded revision and equals the next authoritative read.
5. Given two concurrent saves from one revision, exactly one commits and the
   loser receives `SCM_SCHEDULE_STALE` without changing stored values.
6. Given an exact alias schedule at `Planned` and a linked NetSuite source whose
   initial SCM status remains `Hold`, PO/TO Schedule and both PO Split list and
   detail return `Planned`. A separate exact alias that is only `Queued` may
   still inherit that source `Hold`.
7. Given blank persisted planning details and an active Dispatch assignment,
   PO/TO Schedule and PO Split list/detail show the same assignment ETA date,
   ETA time, driver, truck/load/parking annotation, status, and schedule
   revision.

## Invariants and constraints

- No production mutation is used for reproduction; production diagnosis is
  read-only and automated writes run only in disposable test databases.
- Public endpoint and response shapes remain backward compatible.
- PO Split search remains bounded and indexed; this change must not replace the
  catalog with an unbounded PO query.
- Existing reconciliation/completion status precedence and restricted-order
  visibility remain unchanged.
- No new dependency or migration is required.
- The existing dirty worktree is user-owned; unrelated changes are preserved.
