# Regrouping an explicitly retired group on another date

Risk tier 3: Dispatch lifecycle consistency and preservation of saved work.
Spec approval: not obtained (autonomous run investigating the reported save
failure for GOA-10979-10980).

## Acceptance criteria

1. Create a group on date A, explicitly retire it, and explicitly recreate the
   same reference on date B without assigning a load. The acknowledged save
   must persist an active global definition. A subsequent save without another
   reactivation flag must pass retirement validation and retain current cargo.
2. Match explicit intent case-insensitively. Apply the same behavior to SO, TO,
   and genuine grouped CO records. Preserve the original source-plan provenance.
3. A stale unassigned or assigned snapshot without explicit intent must never
   reactivate the retired definition. Strict validation must still return
   DISPATCH_DERIVED_ORDER_RETIRED; non-strict synchronization must omit it.
4. An active group owned by another plan must not be overwritten by an
   unassigned snapshot, even if a reactivation flag is supplied. Other retired
   groups must remain retired when only one reference is explicitly recreated.
5. Writes remain within the existing transaction and definition locks. Rollback
   must restore the retired state, and competing stale synchronization must not
   defeat retirement. Repeated saves preserve canonical metadata and cargo.
6. Reproduce the acceptance behavior through the normal planner HTTP command
   path as well as the repository. Preserve existing lifecycle regressions.

## Failure model and setup

Partial acknowledgements are caught by persisted-definition assertions and a
second ordinary save. Accidental resurrection and cross-plan overwrites are
caught by negative and randomized tests; rollback and race regressions cover
atomicity. Use the existing isolated test runner, Node/PostgreSQL, fast-check,
ESLint and coverage tooling. No dependencies, commits, schema migrations or
production business-data changes are part of this source correction. Retain
only source tests/spec/evidence and operational audit records; remove all test
containers, volumes, networks, logs and generated artifacts after each run.

The live audit shows explicit regrouping at 19:27:52 and 19:28:44 UTC on October
28, 2026. Plan 372 (October 29) acknowledged the recreated group at revision 12,
while its global definition remained retired under source plan 371 (October 28).
Recovery 21337 contains the subsequently rejected load placement. These are
diagnostic observations, not authorization to overwrite the active route.
