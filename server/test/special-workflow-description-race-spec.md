# SCM description synchronization during PO creation

Spec approval: not obtained (autonomous run). Tier 3: financial records,
concurrent webhook updates, exact line identities and duplicate prevention.

The user confirms that SCM may revise the description: update the exact linked
SO line first, preserve item/quantity/UOM/rate and ancillary lines, then create
the PO with the reviewed description. SPREQ-000007 already has the revised SO
description and remote PO POB03934; recovery must link that existing PO and
never submit another. SPREQ-000006 remains untouched.

Observed failure: the SO webhook received the new description before the app
recorded its completed description update. Strict reconciliation raised a
false mismatch and advanced the case revision. The operation then failed its
revision check. A later PO was created, but another webhook revision made its
final link fail; returning an unawaited link promise bypassed the service's
failure handler, leaving the PO operation stuck in `creating`.

Acceptance:

1. Default/manual order coverage remains exact. During an owned PO operation,
   reconciliation may recognize either the saved SO description or the exact
   persisted SCM description, only for the same reviewed special-item line
   and its known remote unique key. Unknown descriptions, another line, changed
   item, quantity, UOM and extra lines remain mismatches.
2. Claiming or editing still requires the current revision. Internal progress
   after claim is protected by the exact creating operation and frozen draft,
   so a benign webhook revision cannot break description recording, durable
   submission marking or verified final linking. A different operation, future
   revision, closed case or lost SO approval must remain blocked.
3. The revised SO description is verified before PO POST. Webhooks arriving
   after PATCH, before submission, or after PO creation do not cause another
   PATCH/POST, false mismatch or stuck operation. Repeated item IDs retain
   their distinct remote identities; prices/quantities/pallets stay unchanged.
4. Asynchronous SO/PO final-link failures run the existing attention handler.
   Unknown submission outcomes retain their durable lock and recover by marker.
5. Read back SO SOB121380 and PO POB03934, verify reviewed values and one marker,
   then finish linking the existing PO under the same operation. No NetSuite
   create or edit is needed for this case's recovery; verify SPREQ-000006's
   fingerprint before and after.

Failure model / verification: full special-workflow regression suite; failing
contract and real-PostgreSQL interleaving tests; generated description/identity
adversaries; focused coverage, types/syntax, lint, manual mutation, seeded suite
order and live readback. No blanket description relaxation or automatic POST
retry. Keep post-claim user edits locked. Setup uses the existing isolated test
runner and database, adds no dependencies/migrations/commits, and preserves the
dirty workspace. Deploy only this task's reviewed modules over current images
with configuration/hash checks and rollback. Report any baseline failure.

Scope addition requested by the user: native NetSuite SO–PO linkage like
SOB121261 / POB03931. Account readback confirms `SpecOrd` transaction-line
links, SO `createPo=SpecOrd` / `createdPo`, and PO `createdFrom`. The current
standalone creation path has none of those links. A bounded attempt to attach
existing POB03934 with PO source-line fields was rejected as NONEXISTENT_FIELD
(`orderLine`); readback confirms unchanged commercial values and no link.
Do not delete/recreate that existing PO without an explicit instruction.

Additional acceptance (same autonomous approval status):

6. For a PO with an SO, use the documented native Special Order mechanism:
   PATCH only the exact reviewed SO material lines with `createPo=SpecOrd`,
   SCM vendor and purchase cost. Verify SO item/description/quantity/UOM/sales
   prices and ancillary lines remain unchanged. No standalone PO POST follows
   a native creation attempt. A PO without an SO keeps standalone creation.
7. Read the native SO line references before any creation. All reviewed lines
   must point to one PO; partial/different links fail closed. Verify the PO's
   created-from SO, vendor, yard, reviewed items, quantities, units, descriptions
   and purchase costs before accepting it. Preserve any existing memo while
   adding the case marker. Recover native links even if the marker is absent
   after a lost response; a durable prior submission is never rearmed.
8. Native creation initially requires equal SO/PO quantity and native UOM;
   reject a differing review before any NetSuite mutation instead of changing
   SO quantities or accepting an unreviewed purchase. The user has been asked
   whether differing quantities should instead retain standalone creation;
   unless steered otherwise, use matching quantities for the native link.
9. NetSuite evidence is read-only after the rejected existing-link attempt.
   Native creation is tested at the real REST adapter boundary with generated
   line identities and failure/recovery scenarios; no duplicate or dummy
   financial order is created in production for testing. Record this live
   creation limitation explicitly.

User clarification superseding quantity-preservation clauses 1/3/8 for reviewed
material lines: “correct the SO, then update/create the PO if there are
difference.” SCM's reviewed quantity, native UOM and description become the SO
target before creating/updating its native PO. Preserve the SO's sales unit
rate and all unreviewed lines. Accept only complete original/target line tuples
on recovery, never a hybrid or arbitrary remote edit. Update the app's SO
snapshot and case sales quantity/UOM only after remote verification. Native
PO updates use exact transaction-line links, retain the PO identity, and block
closed/received/billed lines or foreign vendor/source/yard. The old regression
expecting SO quantity 1200 while SCM reviewed PO quantity 20 is deliberately
revised to SO=PO=20 under this explicit user instruction; this is a behavior
change, not a test relaxation.

Adversarial addition: if the SO already points to a native PO, verify that PO
is open, unreceived, unbilled and for the reviewed vendor before the first SO
correction. A blocked downstream PO must not leave a newly modified SO.

Pending native creation flags without a visible PO are uncertain outcomes,
including flags on unreviewed SO lines. Do not save that SO again or submit a
standalone PO; recover once the native link is visible.
