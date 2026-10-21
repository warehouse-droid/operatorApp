# Damage posting confirmation and retained retries — 1 October 2026

Tier 3: inventory movement, interrupted network writes, concurrent retries, and
retained operator evidence. Spec approval: not obtained (autonomous run under
the user's explicit instruction to resolve the issues and perform the fix).

## Acceptance scenarios

- P1: Given NetSuite replaces a damage line's description with the item
  description, a successful create or append still confirms exactly the new
  line, stores its line number, links its original photo, and leaves no duplicate
  attention card. An existing identical SKU/quantity is never claimed instead.
- P2: Before a write, atomically save the full stock-line snapshot and report
  receipt in the existing audit table. Write a report receipt in the supported
  transfer memo, preserving its yard/month prefix and any existing memo text.
  The description marker remains compatible with existing reports.
- P3: A response lost after an accepted create/append can be rechecked after
  restart, using the saved receipt and snapshot, without any second stock write.
  A missing receipt, changed prior line, extra line, wrong location, mismatched
  SKU/quantity/UOM/reason, or incomplete transfer must remain unconfirmed.
- P4: Concurrent retry/worker attempts share the monthly lock and produce at
  most one stock write. A definite rejection permits operator retry; an unknown
  result permits only a read/recheck. Attention reports never resend themselves.
- P5: Reconcile the uniquely verified historical Pisa lines without moving any
  stock. Post the authorized October UCARA report once. The identical September
  UCARA report requires clarification whether it is a separate event; do not
  infer that two submissions authorize two movements for the same event.
- D1: SKU, entered quantity, reason, request ID, and original photos survive a
  page reload in an actor-and-yard-scoped IndexedDB draft. Five original photos
  need not fit localStorage. Quantity and photos clear only after confirmation.
- D2: An accepted app report polls its saved posting status. On transfer failure,
  show the retained quantity/photos and an explicit Retry posting or Recheck
  action in the entry flow. Retry uses the existing report, without re-entry,
  another photo upload, or a new report ID.
- D3: An upload or submission interruption retains the draft and each completed
  upload. A submission with a lost acknowledgment resubmits the same immutable
  payload/request ID. Prevent editing an uncertain submitted payload. A definite
  validation rejection allows correction. An unavailable device cache surfaces
  an error and does not discard the in-memory evidence.
- D4: Opening another yard/account cannot load or overwrite the first draft.
  Late poll/upload responses cannot replace another context's form. A failed
  report remains available from the server even if the device draft is absent.
- D5: Initial entry status reads use local saved reports, avoiding NetSuite
  history queries. Existing monthly review, photo ZIP names, photo access rules,
  count-sheet behavior, and NetSuite stock location/unit/reason rules continue
  to work. Cache versions ensure the browser loads the new retry flow.

## Failure model and checks

- Duplicate movement after timeout: realistic stripped-description service
  contract tests, persisted-proof recovery, concurrent stress, and mutants.
- False confirmation of an old or externally changed line: exact before/after
  snapshots, receipt ownership, adversarial variations, and generated properties.
- Partial audit/status persistence: both are one database transaction before
  sending; exercise interrupted write/recovery and inspect the audit evidence.
- Lost photos or quantity: real Chromium reload, partial-upload and rejected-IT
  retries, account/yard isolation, and unavailable-cache checks.
- Silent accepted-versus-posted confusion: status polling and visible retry
  controls, tested on entry and after reload.
- Deployment regression/data loss: scoped image over the current live source,
  source hashes, baseline failure comparison, health checks and rollback image;
  no migrations or unrelated business-record changes.

## Setup and evidence

Use existing Node 20, PostgreSQL, Playwright, c8, ESLint, TypeScript and fast-check
in isolated Docker services with NetSuite writes disabled. Add no dependencies.
Preserve the dirty workspace; use scoped snapshots/hashes, not broad commits or
resets. Persist tests and validation/release/recovery tools in this repository.
Record baseline and final suite results, changed-line coverage, manual mutants,
property/adversarial results, type/lint comparison, original-photo integrity,
and current live transfer lines in the evidence report.

## Clarification accepted during investigation

The user confirmed September/October UCARA is one damage event. Retain the
September report and photo as superseded audit history, disable its retry and
month fence, and post only the October report. Use the existing audit table for
the supersession; no schema migration or deletion is required. The server saved
the reports at 18:54 September 30 and 13:21 October 1 Toronto time, about 18.5
hours apart; timezone alone did not create the two IDs.

C1–C3: Control uses the same read-only description field for confirmation. A
quantity update must confirm its stock fields despite the returned full item
description. New Control lines use a memo receipt and an exact, count-preserving
comparison of the saved adjustment plan to the current transfer; retain legacy
markers, custom fields, bin assignments, and protection against partial edits.

The user approved linking September's existing 10 PC Pisa line to its original
9 PC report. Preserve the live R3 reason as well as its originally reported R2
reason in history. This is an explicitly authorized historical link; automatic
receipt-based posting confirmation continues to require all stock fields match.

D4 additional adversarial case: pause the first of two photo uploads, switch
yards, then finish that upload. Cache its completed reference under the original
yard and stop before uploading any remaining photos or submitting the report.
Returning to the original yard must reuse that reference and upload only the
remaining original. The browser RED test reproduced an upload to the wrong yard;
the final context guard and its dedicated mutation cover this race.
