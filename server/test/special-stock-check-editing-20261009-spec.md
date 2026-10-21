# SCM stock-check revision and SPREQ-000063

Tier 3 because customer decisions and SCM write authorization are involved.
Spec approval: user authorized the fix and explicitly selected reopening a declined
line for customer confirmation; remaining acceptance criteria proceed autonomously.

1. A Special request with ten replied lines and an unanswered declined Split Pallet
   Fee awaits customer confirmation in detail, queue filters, SQL stages and Sales
   alerts. An unanswered open line or a requested update still keeps New enquiry.
2. Before order creation, SCM can explicitly choose Revise stock check on a declined
   line, edit its supply status, ETA and reply, and save it. The line becomes pending
   customer confirmation, old decline metadata is cleared, and an audit records the
   previous decision and reason. Untouched declined lines stay declined on other saves.
3. The existing SCM write endpoint rejects Sales and unauthenticated callers. Closed
   lines, closed cases, pending information, issued/skipped orders and active operations
   cannot reopen a decline. Existing accepted-line readiness checks remain available.
4. Invalid batches and stale/concurrent revisions produce no partial updates. Other
   lines, quantities, sales prices, existing order protections and Backorders retain
   their behavior. No NetSuite writes or new dependencies are needed.
5. Deploy only the tested SCM assets, repository patch and a reversible SQL-view
   migration on the current application image. Preserve a rollback image/view and
   operational evidence. Verify SPREQ-000063 now awaits customer confirmation without
   inventing supply availability or a customer decision for its declined fee.

Failure model: silent reopening is covered by browser opt-in tests; unauthorized or
post-order writes by real authenticated HTTP tests; partial/stale changes by batch
rollback and concurrent HTTP checks; inconsistent queue/alerts by SQL/API property
checks; unrelated deployment drift by live file/config hashes and rollback checks.

Setup: use the repository's isolated Compose configuration and cached test image,
bounded by mbbs-tests.slice. Register cleanup before starting any containers and use
down --volumes --remove-orphans on every exit, then verify docker ps and docker ps -a.
Use existing Node test, Playwright, fast-check, c8, ESLint and TypeScript. Add tests,
reproducible check/deploy scripts and evidence; make no commits and install no packages.
