# Unified regular-stock status acceptance specification

The user approved the six-status plan and requested implementation. This executable
expansion is an autonomous run; separate executable-spec approval was not obtained.
Tier 3 (additive read API and filters). No new dependencies, commits, deployment,
database migration, or production writes are part of this implementation.

## Acceptance criteria

1. Pickup, Delivery, Stocking Transfer/Purchase, Backorder and Waitlist expose the
   same six main statuses in Sales and SCM: pending_scm, pending_sales,
   waiting_stock, in_progress, completed and closed.
2. Pickup approval awaiting an SO is pending_sales; expired unused approval remains
   pending_sales with attention. Stocking never expires. Terminal requests never
   turn expired. Delivery's completed handoff alone does not complete its transfer.
3. Stocking resolution with a PO is completed; rejected, cancelled and manually
   closed work is closed with its true outcome. Mixed terminal success and closure
   is completed unless the entire request was explicitly closed.
4. Open lines dominate terminal lines. Mixed active statuses use pending_scm,
   pending_sales, in_progress, waiting_stock precedence and expose line counts.
5. Waitlist waiting/allocated/converting/completed/closed states map respectively
   to waiting_stock/pending_sales/in_progress/completed/closed. Partial allocation
   remains actionable; released allocation returns to waiting_stock.
6. Production and vendor-transfer are independent badges, including before Sales
   accepts. Both may coexist. Removed, declined, closed, rejected, cancelled or
   already-ordered lines cannot contribute badges. Dispatch readiness suppresses
   stale waiting evidence, matching Special Orders. Never infer a production reason.
7. Filters for unifiedStatus, outcome and waitingReason agree with displayed
   summaries, combine with existing type/yard/vendor filters, and apply before
   pagination. Reject hostile/unsupported filter values with HTTP 400. Existing
   callers without the new parameters retain their old list semantics.
8. Sales and SCM default to All active and can select Completed, Closed or All
   statuses. The SCM Waitlist workspace exposes the same status/filters and can
   show terminal history without offering terminal records actionable controls.
9. Status presentation does not change workflow writes, permissions, order creation,
   underlying status fields, or Special Order behavior. Shared English/Chinese labels,
   escaped output, selection, search and mobile layouts remain functional.

## Failure model and setup

Misclassification: example/property tests, five isolated manual mutants. Hidden
requests: real SQL/HTTP pagination, type and yard-scope cases. UI disagreement:
browser checks against HTTP summaries. Unsafe workflow changes: existing regular,
Backorder and Waitlist regressions. External side effects: existing isolated test
environment disables external writes. Production health and container cleanup are
verified after every runner invocation.

Additional regression: compact SCM Waitlist rows and full detail rows must return
identical status summaries, including a rejected waitlist and a completed SO conversion.
The underlying generic line status must not introduce a second, conflicting outcome.

Additional compatibility checks: SCM Backorder case-stage filters still intersect
the new status filters when the legacy queue is empty. Saved filters survive a
reload; clearing returns to All active. Chinese uses the shared status dictionary.
Closed SCM Waitlist rows have no Reject control. Mobile checks wait for responsive
layout to settle while retaining the original one-pixel overflow tolerance.

The existing Resolve browser regression now selects the new status control in
place of the removed queue menu. Its no-submit, unchanged-record and discarded
draft assertions remain; changing status must discard the unfinished Resolve draft.
The filter examples additionally assert that a mismatched supply reason is excluded
after the manual ignore-supply-filter mutant exposed a missing negative example.

Desktop filters must wrap within the viewport as well as on mobile. Deep links
must open the requested record even when more than 100 newer records precede it;
the authorized detail supplies the request reference used to locate that record.

Completed Resolve requests leave the active queue. The existing browser regression
now selects Completed before inspecting the saved PO/ETA; all persisted-data,
required-input, no-extra-submission and result assertions are retained.

Use the installed Node/Playwright/PostgreSQL images and standard isolated Compose
configuration with a unique project, mbbs-tests.slice, bounded resources and a
teardown trap registered before any container is created. Keep logs/screenshots
under test-artifacts/unified-stock-status, never disposable databases. The entry
point is server/tools/unified-stock-status-check.sh.
