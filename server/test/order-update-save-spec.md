# Order updates and Dispatch autosave — Tier 3 executable specification

Approved scope: the user's “Implement the plan” instruction on September 17,
2026, plus explicit regression coverage for groups, splits, CO, linked TO/PO,
address changes and address overrides. This specification records that plan;
it does not authorize changing existing business rules.

## Failure model and acceptance scenarios

1. **Cleanup races with autosave.** Reproduce the incident: a plan at revision
   63 contains two unused split snapshots; Driver completion requests billed
   family cleanup while its date has an edit lease. Its persisted revision,
   digest, trucks and stops remain unchanged. The next automatic save applies
   the dispatcher movement and eligible cleanup in one revision, and returns
   that final digest. Both classic and V2 saves, including compact receipts,
   retain their fence and idempotency contracts.
2. **Cross-date maintenance.** The same family can appear on two dates. Defer
   the edited date, process an unleased date, and notify every changed date
   after commit. A rolled-back transaction emits nothing.
3. **Durability and races.** Coalesce pending work by plan and operation;
   complete only the requested generation. Source updates remain live.
   Release, expiry, restart and failed processing retain/drain work correctly.
   A worker cannot write underneath a newly acquired lease. Use fleet → date
   → plan lock order. Unchanged maintenance creates no history or revision.
4. **Protected Driver evidence.** In-progress/completed stops, completion
   records, quantities and photos survive. Protected cleanup stays queued
   without preventing an unrelated valid movement. NetSuite-fulfilled but
   physically pending deliveries keep existing planning eligibility.
5. **All requested actions.** Exercise grouped orders, split orders, CO,
   linked TO, linked PO, address changes and address overrides while source
   maintenance is pending, then verify the saved snapshot and projections.
   Retain existing dependency, pickup-allocation, confirmation, assignment,
   history and authorization validation.
6. **Other automatic writers.** Coordinate split-reference retirement,
   purchase-order reference updates and automatic CO identity repairs.
   Preserve explicit dispatcher operations and source updates.
7. **Browser continuity.** Verify a fresh snapshot after acquiring Edit Mode.
   Ignore refreshes/recovery reads overtaken by another generation, saved
   acknowledgement or date. Preserve rapid edits, Undo/Redo, immutable
   request retries, local drafts and unrelated recovery records. Clear only
   recovery work proven saved. No refresh/re-edit workaround is required.
8. **Compatibility and performance.** Existing APIs and business safeguards
   remain; no new dependency. Existing full suite has zero new failures.
   Keep the existing 500 ms action-feedback and startup/save performance gates.

## Setup and verification

Use the existing Docker Node/PostgreSQL/Playwright tooling with disposable
test databases, never historical production plan writes. Add an additive
maintenance migration, focused integration/property/frontend regressions and
a reproducible gauntlet/evidence report. Preserve the dirty workspace using
pre-task file copies and source hashes; no checkpoint commits are requested.
Run RED before implementation, full and affected suites, type/lint baseline
comparisons, changed-line coverage, targeted mutants (also properties alone),
race tests and Chromium/WebKit execution. Report any unverified layer honestly.

Deployment preparation must apply schema before application/worker rollout,
preserve pending work across rollback and verify release/expiry draining.
Production deployment is a separate concrete reviewable action once evidence
is ready; this implementation does not edit production history for testing.

Implementation clarification: link TO/PO actions already use an atomic plan
command. Their successful acknowledgement advances the revision once, with
maintenance included. Tests must preserve that behavior rather than demand
that an explicitly requested plan action leave the revision unchanged.

Archived replay clarification: original order and truck structures and the
failed save fence are retained. Full historical source eligibility and the
failed request payload are unavailable. Replay verifies those structures and
all non-cleanup summary fields exactly; cleanup audit metadata is asserted
against the reconstructed source family and the new execution timestamp.

Buffered-edit clarification: applied PO-reference and unsplit corrections remain
available until the edit lease ends. This prevents a later buffered payload
from resurrecting an old identity. Applied corrections do not make an unchanged
save advance the revision; release/expiry clears them without another write.

Performance acceptance amendment — September 18, 2026: the user explicitly
accepted and requested documentation of the measured six-pair differences for
this fix: Chromium first-navigation mean +17.55 ms, WebKit first-navigation
mean +38.17 ms, and WebKit edit p95 +15.00 ms. This scoped acceptance resolves
the failed no-slowdown checks in scenario 8 for the verified implementation.
The original benchmark results and assertions remain unchanged. Repeated
navigation and save latency meet their existing gates. This acceptance does
not cover future regressions or authorize production deployment.
