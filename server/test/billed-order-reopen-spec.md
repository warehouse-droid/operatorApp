# Billed order reopen and Dispatch PO linking

Autonomous bug-fix run; spec approval was not obtained. Tier 3 applies to
fulfillment safeguards. Existing tools and dependencies only; no commits,
schema changes, NetSuite writes, or production order mutations are required.

1. A sales order with status G / Billed, no recorded fulfillment, and local
   packing or loading may reopen through the existing authorized Control API.
   Its NetSuite status, ordered quantities, photos and history remain intact.
2. Pending Billing, actual fulfillment IDs/timestamps/quantities, active IF
   snapshots, receiving, closed/inactive orders, active posting/reload claims,
   and started Driver work continue to block reopening. Deleted IF snapshots
   alone do not block. Authorization, stale previews and idempotency remain.
3. Dispatch shows Link PO for a Billed sales order that current server authority
   permits planning and that has no displayed local execution. It labels that
   state Billed in NetSuite rather than Loaded/shipped history. Other actions
   retain their current guards. Restricted, loaded, fulfilled, non-SO and
   Pending Billing records do not gain a Link PO exception.
4. Existing PO preview/commit validation remains authoritative. Reopening an
   unfulfilled Billed fixture permits the same PO preview as an open fixture.
   A loaded fixture remains blocked until its authorized reset.

Failure model: losing financial truth/history (before/after conservation),
reopening fulfilled work (negative evidence matrix), bypassing roles/yards
(existing HTTP tests), stale/replayed reset (existing race and retry suite),
UI/backend disagreement (real HTTP and production render tests), and release
drift (live-source capture, narrow overlay, hashes and rollback image).

Setup and execution: capture live source; add regression tests before runtime
edits; use the standard isolated Compose file with mbbs-tests.slice and bounded
containers. Register finally teardown before startup, remove volumes/networks,
verify docker ps and ps -a and production health. Save logs, changed-line
coverage, static baseline comparison, mutation results and release evidence.
Full relevant reopen/Dispatch suites are the calibrated regression boundary;
unrelated application suites are outside this change.

Spec correction after schema inspection: transaction snapshots support PO/TO,
not SO. For this sales-order fix, scenario 2 uses the actual durable SO
delivery_fulfillment_records table: a posted fulfillment ID blocks; historical
photo records without a fulfillment ID do not. No snapshot behavior changes.
