# Special SO creation confirmation

The user changed the acceptance rule on 2026-10-10: after an SO exists, the
application needs its number and creation result, without comparing content.
This replaces the earlier proposal to repair total-discount content verification.
Spec approval: not obtained (autonomous run); the behavior follows the explicit
user instruction. Existing test tools and dependencies are sufficient. No
dependency, migration, Git commit, or NetSuite write is needed for recovery.

Acceptance cases:

1. Standalone, discounted, and estimate SO creation save the existing SO ID and
   number after a successful NetSuite reference read. No post-create item,
   quantity, UOM, price, discount, customer, or yard comparison runs.
2. Recovery finds the exact request marker, including its external ID when the
   memo has changed. A changed customer/yard or unavailable draft-unit/yard
   lookup does not prevent linking an already created SO.
3. Missing numbers, invalid IDs, ambiguous markers, and uncertain submissions
   remain unresolved. Recovery never resubmits an already started operation.
4. A verified remote SO link remains linked without content attention, including
   after an SO webhook before PO creation. Local revision/operation ownership
   and yard access checks remain required.
5. Native PO preparation resolves the SO line identities at its own operation
   boundary, so removing creation-time comparison does not break PO creation.
6. SOB122477 is recovered to SPREQ-000063 through the original operation and
   exact request marker. NetSuite content and the historical request draft stay
   intact; the audit records the identity-only recovery.

Failure model: a missing marker must not produce a duplicate order; a duplicate
marker must not pick one arbitrary SO; lost acknowledgements must recover the
same SO; asynchronous mirror differences must not misreport SO creation as
failed; later native PO operations must still resolve their required identities.
Tests include service and real-repository execution, seeded properties, manual
mutants, baseline-relative static checks, and deployed read-only verification.
