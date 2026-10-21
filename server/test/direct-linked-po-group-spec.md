# Direct-linked PO completion through split SO groups

The user reports that SN1401884 is complete but its PO/TO schedule status is not.
Read-only production evidence confirms Driver dropoff 5492 completed at
2026-10-02T16:32:30.332758Z for SOA09140-S1 and SOA09143-S1. Active PO links 229
and 230 refer to group GOA-9140S1-9143S1 and root SO references. Canonical SO
split completions exist; the PO completion is missing. Its product is fully linked.

Spec approval: not obtained (autonomous run). The user's existing authorization
to fix and deploy PO/TO status remains in force; no additional dependencies,
commits or external financial postings are authorized by this correction.

Acceptance scenarios:

1. Pickup of the exact grouped split carrying an allocated product projects
   In Transit in full, filtered and reconciliation-enriched schedule rows.
2. Completed dropoff of every required grouped product split appends one PO
   completion at the final required product dropoff's actual Driver timestamp.
3. An undelivered required sibling prevents completion; delivered product
   progress projects Partially Done. An unrelated source sibling cannot supply
   pickup or delivery proof for this group's allocation.
4. Group membership, source SO identity and exact source sales-line identity
   must match; missing or mismatched definitions and insufficient grouped
   quantities fail closed. Wrong Driver order kind and cancelled links cannot
   establish completion.
5. PALLET and Split Pallet Fee retain the previously approved status exclusions.
   Unfinished product quantities remain required, including native quantities.
6. Receipt admission retains the deployed strict contract. Resolving split
   references for transport status cannot newly admit a NetSuite Item Receipt.
   No order header, line quantity, link, split, group or Driver history is changed.
7. Recovery is bounded to SN1401884's exact ID and reference, uses Driver 5492
   with its full timestamp precision, is idempotent and passes a rollback rehearsal.
   Existing PO/TO, split isolation, prior repaired dates and waitlist behavior persist.

Failure model: parent-to-sibling leakage, partly delivered groups, stale group
quantities, false type inference, new financial admission, duplicate recovery,
partial migration and concurrent source changes. Real PostgreSQL integration,
property quantities, deliberate mutations, unchanged-source fingerprints,
transaction rollback and an app-only release over fresh live source verify these.

Setup uses existing remote-disabled Docker test runners and cached dependencies.
Add one migration, the shared schedule query change, this spec, integration tests,
recovery/release scripts and evidence. Preserve concurrent workspace edits. Deploy
only the frozen tested overlay; retain the previous image for rollback.

Compatibility clarification: older group links without any persisted canonical
group definition keep their deployed exact root-SO matching. Existing regression
fixtures exercise this contract. Once a group definition exists, missing child
or line identity and insufficient quantities fail closed; a root SO cannot
substitute for its required split children. This is a narrower scope than blanket
rejection of every legacy group missing a canonical definition.

The older partial-PO two-route fixture used a PALLET-only second SO. Under the
user's approved exclusion that SO cannot remain the outstanding product needed
by the test's assertions. Those two scenarios now explicitly request a second
product fixture; every existing timing, completion and planning assertion is
retained. The change is limited to the fixture selected by those scenarios.

Deployment verification found a production-scale query planning regression:
group reference resolution was repeated across Driver history. The first app
release was rolled back; the compatible migration and verified immutable
SN1401884 completion were retained. The query now materializes resolved links
and matching Driver candidates before applying strict order-kind checks.
Acceptance additionally requires the frozen candidate to pass exact-reference,
enriched, single-order and full schedule projections against the live dataset
in read-only transactions with a 10-second per-statement timeout before cutover.
Full-list performance checks use the actual active and completed list views.
The statusProjectionOnly API requires exact references and intentionally returns
an empty array without them; its single-order check retains SN1401884's exact ref.
The completed list includes Cancelled rows under the existing repository API
contract. The new performance check verifies both closing statuses; its initial
Completed-only expectation was incorrect. The order-specific Completed and exact
delivery timestamp assertions remain unchanged.
