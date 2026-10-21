# Special Request native UOM identity repair

Spec approval: not obtained (autonomous run). The user reported the identity
error for SPREQ-000032; this specification is available for review after the fix.
Tier 3: a small boundary repair used by sales and purchase order workflows.

Observed failure: SPREQ-000032 (request 109) resolves item 2055 from PC to
SQFT while preparing a PO. NetSuite returns SQFT's native unit 866 in the
`rel=self` URL `/services/rest/record/v1/unitstype/353/uom/866`, with neither
`id` nor `internalId` in the UOM object. The current adapter rejects that response.

Acceptance scenarios:

1. The observed link-only response resolves SQFT to unit 866. Quantities,
   descriptions, prices, and other input fields are preserved. Repeated lines
   share one item metadata read and one units-type read.
2. Link-only native UOMs resolve across all four existing name/abbreviation
   fields and numeric/string ID forms, including the REST record type's case.
3. Explicit `internalId` and `id` response fields retain their existing
   precedence and validation; configured PC/EACH units retain the direct path.
4. Missing, malformed, ambiguous, wrong-record, wrong-units-type, zero,
   negative, and unsafe link IDs raise `SPECIAL_UOM_INVALID`. They never cause
   a remote write or substitute an arbitrary unit.
5. Existing line synchronization, conflict detection, retry behavior, payload
   serialization, and configured-unit permission handling have no new failures.

Failure model and checks:

- Wrong unit changes order semantics: exact units-type/path validation,
  generated positive and hostile cases, and wrong-unit mutation tests.
- Lookup changes quantity or money: compare complete resolved input lines and
  retain existing sales/purchase payload and synchronization tests.
- Malformed lookup is silently accepted: reject unsafe/missing identities with
  an actionable UOM error, and mutation-test the rejection guards.
- Deployment overwrites unrelated work: match the live adapter baseline, build
  an overlay containing only this source file, compare source hashes and service
  configuration fingerprints, and retain the prior image for rollback.
- Recovery creates a duplicate PO: this task performs read-only request/NetSuite
  inspection. POB03988 (1038450) is already linked to SOB121972 (1036614).
  Record recovery or order edits require a separately reviewed concrete action.

Setup: use the existing isolated Node 20 test runner and existing fast-check,
c8, TypeScript, and ESLint dependencies. Add one regression test file, this
specification, and reproducible validation/release tools. No new dependencies,
migration, checkpoint commit, or credential persistence is needed. Store only
source backups and configuration fingerprints for the release.

Validation: run the complete affected Special Request boundary unit suite,
strict module type checking, lint, changed-line coverage, manual mutation,
generated/adversarial cases, reversed test order, and real read-only SQFT/PC/EACH
lookups through the application boundary. The repository-wide database/browser
suite is outside this single-file boundary change; record this limitation in
the evidence report.

Reference: Oracle's [Unit of Measure REST documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_63210224348.html)
documents `/unitsType/<type>/uom/<native-unit-id>`.

## Revision 1: enable the user's manual PO link

The user chose to link POB03988 manually after the fix. The old failed-validation
status prevents that action even after deploying the repaired unit lookup.
Clear only the obsolete attention/error and reset the unsubmitted PO operation
to idle for request 109, revision 23, operation
`103a0b2b-5883-41b1-b7cf-0a5ca9bdd859`. Require the exact original identity error,
no PO submission timestamp, no linked PO, active case, and no other pending
quantity/fulfillment operation. Preserve every business field, all order lines,
and both existing NetSuite records. Increment the app revision and record an
internal audit event. Do not create, modify, or link a PO on the user's behalf.

Verify this one-time repair in a transaction that rolls back, then commit the
same guarded transaction and compare all unaffected fields before/after. The
repair is a reversible support action; no generic runtime API is added.
