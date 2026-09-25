# Split group names and customer-pickup pool visibility

Authorized by the user: rename GOB-120921-121097 to GOB-120921S1-121097,
include split suffixes in similar group names, and remove customer-pickup
SOB120921-S2 from the Dispatch delivery pool. Tier 3, local data integrity.
Spec approval: not obtained (autonomous run).

1. Group naming retains S1/S2/S10 for SO/TO/PO and grouped CO members, with
   deterministic ordering and existing collision suffix behavior.
2. Audit active global and delivery groups for missing member split suffixes;
   rename matching groups only. Other active split group names already include
   the required suffix. Preserve membership, quantities, routes and execution.
3. The catalog pool excludes a sales order whose current local method is Pick-Up,
   even when a global split or catalog entry has stale eligible=true. An eligible
   Delivery sibling and its group stay available. Changing back to Delivery
   restores visibility without retiring or recreating the split.
4. Legacy/search feeds also exclude the pickup split from both global definitions
   and saved snapshots. Parent source refresh cannot override the live method.
5. Rename every current reference to the selected group atomically, with a private
   before-image, source snapshot history and audit, revision/fingerprint fencing,
   idle-editor/operation guards, collision checks, and rehearsal rollback.
   Preserve source headers/lines and the five-pallet S2 Pick-Up status. Repeating
   the repair is a no-op. Retain an inactive old definition to fence stale clients.
6. Deploy only the tested backend changes over the live image; preserve the prior
   rollback fix, runtime configuration and unrelated workspace work. Verify
   actual catalog/feed results and public health afterward.

Use existing tooling and the old-coder evidence workflow; add no dependencies and
make no commits. Reuse the immediately preceding full-suite result as a recorded
baseline because these source files have not changed since that run. Run the full
suite after the code change plus focused database, naming, legacy-feed, property,
mutation and rollback checks. No NetSuite writes or artificial production races.
