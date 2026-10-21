# Linked order closure, 2026-10-15

Scope: fix the close action; do not close SPREQ-000099 or write any live order as part of this task.
Behavior approval: user explicitly confirmed: "do not compare the line, just post to close the linked SO and PO".
Tier 3 because the action closes commercial orders. Detailed test/setup review was not obtained (autonomous run).

Acceptance criteria:

1. Read current NetSuite lines by the linked SO and PO IDs. Added, removed, replaced,
   re-priced, re-described, re-quantified, re-unitized and discount lines need not match
   the request's saved lines. Close current open material lines, PO before SO.
2. Closure does not resolve the request's old item/unit mappings. An absent or stale
   local line snapshot cannot prevent closure of the linked orders.
3. PATCH contains only line IDs and isClosed=true. Preserve all quantities, prices,
   descriptions, item IDs and units. Never write an unrelated order.
4. Verify both orders before local cancellation; partial or lost responses leave a
   retryable journal and retries do not re-close already closed lines.
5. Preserve existing execution, billing, planning, access, review-lock and exact
   linked-order identity checks. Preserve checks for changes during an in-flight
   saved closure plan and workflow-locked closed-order recovery.

Existing tests that rejected differences from the request must change explicitly:
the same differences after preparing a remote snapshot must still reject. This is
the requested behavior change, not a relaxation of tests for execution or billing.

Failure model: wrong order (identity + payload tests), stale local lines (regression
and generated cases), partial close (journal integration + lost-response retry),
concurrent remote change (snapshot regression), concurrent reviewers (existing DB
lock test), premature local close (real repository integration), workflow locks
(existing query-evidence tests), production/test interference (isolated Compose,
bounded containers, finally teardown, production health check).

Setup: use existing Node, node:test, fast-check, c8, ESLint and TypeScript tooling.
No dependency, schema, configuration or public route changes; no commits. Save the
live runtime baseline, tests, mutation runner and evidence under the task's tools
and test-artifacts directories. Tests use the standard isolated Compose settings
and disposable PostgreSQL; register teardown before starting. Deploy only the two
changed closure modules over the current live app image, with rollback available.
No production closure POST/PATCH is part of validation.
