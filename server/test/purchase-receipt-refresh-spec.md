# Receipt-triggered source PO refresh

Spec approval: not obtained (autonomous run under the user's requested fix).
Tier 3: durable background work affects concurrent receipt processing and inventory evidence.

Acceptance criteria:

1. Saving a PO receipt, including a local split child, commits one delayed refresh
   for the canonical NetSuite parent PO in the same transaction. Unknown orders
   and transfer orders do not become PO jobs. Failed receipt saves roll back jobs.
2. An accepted, non-stale PO IR webhook durably queues that refresh before HTTP
   acknowledgement, independently of the SCM reconciliation lock. Ignored,
   stale and non-PO events do not queue it. Duplicate deliveries coalesce.
3. A receipt signal while a job is running survives its completion as one pending
   follow-up. Concurrent duplicate signals cannot create duplicate active jobs;
   expired leases and stale worker tokens remain fenced.
4. The leased worker reads PO lines including received quantities even when the
   PO timestamp/status did not change. It atomically applies those quantities,
   removed-line state and status, then reconciles linked Special requests. Every
   regular/backorder request sharing any refreshed PO sees current receipt evidence.
   Partial receipts remain partial; unrelated production lines are not completed.
5. A bounded catch-up queues at most ten stale linked POs per fifteen-minute
   tick, with six-hour recent-attempt suppression; it covers header, per-line,
   and regular purchase-demand links and does not depend on PO modified time.
6. Failed remote reads or local writes retry; no partial status/progress commit.
   Existing SO/TO behavior, receiving photos, local receipt evidence, request
   quantities, prices, approval and completion workflows remain intact.

User clarification, STREQ-000163: when all remaining Backorder lines are Already
Ordered and their linked POs have arrived, show the request as Completed even if
its linked customer SO is awaiting fulfillment. This is a request display status;
it must not fulfill the SO, close requests, or complete a separate production line.
The existing arrival API/browser tests' two final `in_progress` assertions are
superseded by that instruction and now assert exactly `completed`; their partial
arrival, alert, acknowledgement and permission assertions remain intact.

Concurrency refinement: acquire the source queue lock before receipt PO writes,
including direct-PO finalization. A real two-connection test reproduced a deadlock
with the opposite order; receipt/worker saves must both succeed after the fix.

Failure model: dropped/duplicate receipt signals (transaction and race tests),
wrong child-to-source identity (nested/cyclic/unknown identity tests), stale or
partial receipt evidence (quantity/projection tests), partial writes (rollback
tests), runaway polling (bounded selection tests), silent failure (audit/retry
tests), unrelated release regression (merge delta onto captured live source).

Setup: existing Node test runner, PostgreSQL disposable runner, fast-check, c8,
TypeScript and ESLint. No dependencies, credentials or git commits added.
Add one backwards-compatible boolean queue column; retain rollback image and
operational repair/deployment audits. Use the bounded disposable Docker runner
with automatic teardown and artifact deletion. Validate candidate source, deploy
the scoped change, verify health and the four reported request projections.
