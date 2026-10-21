# Control order reopening and dependency diagnostics

Spec approval: not obtained (autonomous run). Tier 3: local progress reset,
authorization, retained evidence, and concurrent Operator mutations.

1. PO-link refusal identifies every affected canonical member, the actual
   progress (preparing, packed, or loaded), and its operator's display name and
   username when recorded. Missing attribution says it was not recorded.
   Existing packing-independent planning and dependency rules remain intact.
2. Control provides an Order Reopen page with order search, an exact preview,
   affected members, retained photo count, a required reason, and explicit
   confirmation. Admins and managers of all affected outbound yards can use it.
   Other roles and managers without assignments cannot read or reset it.
3. Reopen resets all local packing quantities, confirmations, loaded quantities
   and units, preparing ownership/timestamps, and local progress status for SO,
   outbound TO, local CO, and local VRMA. A group resets all members atomically.
   Quantities ordered, item identities, allocations, dispatch assignments,
   inbound TO progress, original photos, and operational history are retained.
4. Local loaded progress, including a stale Open header with loaded lines, can
   reopen. Genuine NetSuite fulfillment/receipt evidence, closed/cancelled
   orders, active reloads, active posting or consolidation claims, and started
   Driver work prevent a reset with a specific explanation. Existing reattempt
   or Driver reopening must resolve these workflows first.
5. A preview fingerprint fences changes to members, quantities, statuses,
   photos, and blocking evidence. Reset locks serialize with Operator load and
   packing mutations. A stale preview or any failed write changes nothing.
6. A UUID request ID binds the actor, exact order reference, preview, and reason.
   Exact retries return the original result without clearing later work or
   duplicating audit. Changed request contents are rejected. Concurrent reset
   requests from the same preview have exactly one successful correction.
7. Reopening appends an immutable correction containing the before state,
   reason, actor, retained photo references, and result. Reopened Operator
   details display retained images as historical evidence. New load evidence
   follows the existing photo requirement.

Failure model: unauthorized cross-yard reset (real HTTP negative tests); lost
photos/ordered quantities/inbound state (database conservation and properties);
partial group reset (transaction failure injection); concurrent pack/post/reset
(real PostgreSQL lock races); replay clearing newly packed work (retry tests);
misleading group attribution (group audit fixtures); stale UI (browser preview
and state-fence tests); additive migration failure (transaction/rollback
rehearsal and idempotent migration check).

Setup: use the existing Node, PostgreSQL, Playwright, c8, ESLint, TypeScript,
and fast-check tools; no new dependencies or commits. Capture the current live
source, then apply only reviewed task overlays. Tests use the standard isolated
Compose configuration with mbbs-tests.slice and bounded resources; teardown is
registered before startup. Save test logs, hashes, coverage, mutation evidence,
release configuration and rollback source. Never use real order resets as tests.

8. Customer Pickup mutations and posting admission share the same local order
   lock as reopening. Driver start shares the fleet execution lock, so a reset
   cannot miss a simultaneously starting Driver record. PostgreSQL race tests
   must observe each operation waiting on the held lock.

9. Current preparing ownership is authoritative for preparation only. It must
   not attribute older imported loaded quantities to that operator when no
   load record or load audit names them. Test each case with an independent
   same-yard fixture; cross-yard refusal must not mask role/actor mistakes.
