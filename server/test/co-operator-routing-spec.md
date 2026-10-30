# CO Operator grouping and destination routing

Spec approval: not obtained (autonomous run). User authorized fixing duplicate
CO item rows and showing source sales orders at the CO destination, not its origin.
Tier 3: quantities, yard authorization, and concurrent packing are affected.

Acceptance criteria:

1. A CO containing two matching EKO lines (3 pallets; 2 pallets and 4 layers)
   presents one editable line totaling 5 pallets, 4 layers, and 564.84 SQFT.
   Different items, units, conversions, and special item descriptions stay separate.
2. Reading the grouped CO changes no stored cargo, source identities, or packing.
   Confirm, absolute edit, and unpack distribute changes to the original lines,
   preserve totals, and cannot exceed any source line's remaining quantity.
   Legacy numeric line IDs remain usable. Load evidence retains original line IDs.
3. For an active CO from 2967 to 3445 containing two source SOs, both standalone
   and grouped Operator reads route the SOs to 3445 and the CO to 2967. A 2967-only
   operator cannot act on destination SOs; a 3445 operator can read them.
4. Source SO packing is blocked before verified arrival, including after CO load.
   Receipt or verified driver completion enables packing at the destination.
   Cancellation restores original SO yard routing. NetSuite mirror yards stay intact.
5. Unrelated orders, existing group packing, CO linked supply, and load/receipt
   lifecycle keep working. Mutations share the existing order transaction locks.

Failure model: loss/duplication of quantities (integration and property tests),
partial writes or competing tablets (transaction/concurrency regression), wrong
yard access (authorization integration), premature packing (arrival tests), and
stale source identifiers (legacy ID and persisted evidence checks).

Setup: existing Node, PostgreSQL, fast-check, ESLint, TypeScript, and c8 only;
no dependencies, migrations, commits, or production data writes. Use the standard
isolated test runner, mbbs-tests.slice, bounded containers, and its unique artifact
directory. Retain concise evidence here; remove every disposable test resource.
Production deployment is a separate final action after validation.

Added requirement from the user: after 3445 receives the CO, its source SO group
must already be Packed in Delivery Prep and waiting for loading. Receipt must
apply only received cargo to original source line identities, retain the onward
delivery schedule, create no synthetic transfer order for the source group, and
be atomic and safe against repeated receipt. Partial receipt must not invent stock.
This extends criterion 4 from allowing packing to transferring received packing.

2026-10-27 clarification: the user states "Co to 3445 first". The existing SO
loads 7159/7160 and their shipped IF159803/IF159804 must be reviewed as a CO
transfer before customer delivery. Prepare a scoped correction, retaining photos,
timestamps, original identities, and audit evidence. Require verified removal of
the two NetSuite fulfillments before resetting local SO loaded quantities. Keep
the CO awaiting actual Receiving confirmation; do not invent a receipt. Prove that
receipt then packs the original SOs and a later customer load retains its full
quantity. NetSuite transaction deletion requires the user's explicit approval
after the captured records and tested correction are presented.
