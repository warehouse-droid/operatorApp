# Receiving posting status and receipt number

Spec approval: not obtained (autonomous run). Scope: the operator receiving
screen, its cache version, and regression evidence. No new dependencies,
database changes, receipt transforms, or backend verification changes.

Acceptance scenarios:

1. A NetSuite receipt exists but the command needs attention: show the IR
   reference and “NetSuite receipt created”, explain that local verification
   needs review, and prevent a second Receive submission.
2. A polling/network error occurs after admission: retain the request/job ID,
   show verification pending, and use GET requests to recover the same job.
3. A subsequent status read reports completed: display the existing receipt
   result and clear the old error without another POST.
4. Reloading or reopening receiving restores an unacknowledged receipt job,
   including its IR reference; account/order journals remain isolated.
5. Only an authoritative failed job or rejected admission displays receiving
   failure. An observed receipt is not treated as locally completed.
6. Late responses for a previous order cannot replace the active receipt;
   overlapping status checks cannot race or trigger new submissions.
7. Completed receipts use their recorded NetSuite evidence for the success
   message even if the posting gate has since changed.
8. Acknowledging completion clears the journal. Local-only receiving, photo
   submission, and other Operator modules retain their existing behavior.
9. UI text from server receipt references is escaped; missing/invalid browser
   storage does not prevent in-memory recovery.

Failure model (Tier 3 because duplicate receiving affects inventory): duplicate
submission (POST-count and repeated recovery tests); partial completion (attention
and completed fixtures); stale responses (deferred requests and order switches);
lost network/response (request-ID recovery); browser reload (journal replay);
misleading success (no local completion until authoritative completed status).

Validation uses the existing Node test runner, browser VM/Playwright tooling,
lint/type checks, focused coverage and mutation checks, plus the project suite
against an isolated test database. Baselines preserve unrelated workspace changes.
Production checks are read-only. No commits or dependency installs are planned.
