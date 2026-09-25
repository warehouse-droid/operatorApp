# CO source packing handoff

The user explicitly selected: **Clear SO packing; pack on the CO**. Creation or
refresh of a pending transit CO must release the source SO's packed quantities,
line confirmations and preparing ownership at the CO's source yard. Existing CO
packing remains on the CO. Apply this same release to SOA08838/CO-SOA08838 once
verified; keep its direct TOB01102 allocation and Dispatch plan unchanged.

Acceptance criteria:

1. Creating a CO for a packed/preparing SO clears its physical and sales-unit
   packed quantities and confirmations and returns the source to Open without
   copying that packing onto the CO. Ordered quantities, conversions, allocations,
   load/fulfillment quantities and unrelated lines/orders are unchanged.
2. Repeating the operation is idempotent. An existing pending CO retains its own
   packing. Audit the exact released source packing and original header status.
3. For grouped sources, release only canonical SOs at the CO's source yard;
   another yard's SO and non-SO sources are unaffected.
4. Do not clear packing once source loading/fulfillment or CO loading/receiving
   has started, or while a posting/consolidated load owns the source. Reject the
   handoff atomically and leave the prior CO and SO data intact.
5. Operator source-order packing and loading cannot restart while its source-yard
   CO is active. The error directs the operator to that CO. CO packing remains
   usable. Cancellation restores ordinary SO packing eligibility.
   Explicitly recreating that cancelled CO performs the packing handoff again.
6. Serialize the handoff with operator mutations using their existing order
   locks and canonical row locks. An operator update committed before handoff
   must be released, and a source packing attempt after handoff must be rejected.
7. A callback/audit failure rolls back both CO creation and source release. No
   NetSuite writes, synthetic load/receipt records, or schema migration.
8. Rehearse the current SOA08838 correction with rollback, then apply under the
   same locks and compare protected fields/CO packing/dependency rows before and
   after. Do not overwrite operational changes detected since preview.

Failure model / Tier 3 verification: wrong source/yard (group and adversarial
tests), lost loaded evidence (status/line/claim guards), lost concurrent packing
(independent PostgreSQL transactions), partial release (rollback tests), duplicate
or repeated clearing (idempotency and property tests), unusable CO (real Operator
packing API), and regressions (focused/full baseline comparison). Use the existing
old-coder test tools; no packages, commits or unrelated edits. Add a dedicated
handoff module, source callers, tests and a guarded repair tool. The already
approved clear-versus-transfer behavior is the authorization; additional spec
review was not obtained during this autonomous implementation.

Additional invariant discovered during implementation: clearing SO progress must
not make already-packed CO lines appear untouched to TO/PO linking. Link preview
reads CO progress by the selected canonical SO line, and committed TO links lock
the CO alongside the SO/TO. Other packed CO lines still allow an untouched line
to link, preserving the user's earlier approved behavior.
