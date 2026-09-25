# Link TO search, group routing, and grouping

Spec approval: not obtained (autonomous run under the user's three requested fixes).
Tier 3 applies to preserving persisted dependency allocations during regrouping.

Acceptance scenarios:

1. Entering ` tob01135 ` in Link TO searches and submits `TOB01135`; the
   textbox displays uppercase. The server accepts lowercase references too.
2. A group such as GOM-6635-6636 linked to TOB01135 keeps the TO's source yard
   and manifest through refresh, normalization, route reconciliation, and save.
   A pickup precedes its customer drop; the TO is not planned independently.
3. Grouping an unstarted SO already linked to a direct TO is allowed. Its
   persisted dependency target becomes the group. Sales line IDs, source SOs,
   allocated quantities, and TO identity remain unchanged. All member TOs
   appear once in the group route, regardless of selection order.
4. Replenishment sequencing, split protection, source TO grouping protection,
   started execution protection, stale-command guards, and transactional
   rollback remain intact. Unsupported structure changes remain blocked.

Failure model: missing remote pickups (frontend/server route tests); lost or
duplicated cargo (generated quantity invariants); partial dependency moves
(database transaction/rollback tests); grouping after execution (negative
database/UI cases); accidental split/unlink permission (structure guard tests).

Setup: use existing Node/Docker/PostgreSQL/test tools and dependencies. Preserve
the dirty workspace with a separate baseline snapshot; no commits, dependency
changes, migrations, production data edits, or deployment are required. Add
focused regression tests and a reproducible verification command, record
baseline/full-suite failures, and report any unrun verification layers.

Additional adversarial criterion: newly grouped pool orders can be absent from
the saved snapshot. Such a transition must still run dependency structure
validation; started direct links must return 409 without advancing revision.
Unstarted canonical SOs absent from that snapshot remain valid group members.

Correction to the HTTP status above: the existing save contract archives blocked
edits as recovery drafts (HTTP 202), rather than returning 409. The stronger
assertion is the exact recovery response with `applied: false`, an
`ORDER_DEPENDENCY_STRUCTURE_LOCK` validation issue, unchanged active revision,
and unchanged dependency target. Repository guards still throw status 409.

Reference compatibility: matching ignores case in stored TO references too.
Persisted links and execution checks use the exact canonical reference returned
from the database, so normalizing user input cannot bypass existing activity.

Deployment scope update: the user subsequently requested completion of the fix
deployment within one hour. Prepare and verify scoped app and worker images
against their respective running images, preserve unrelated changes, apply
without migrations, and verify health, asset hashes, and the reported group
using a read-only database transaction. Retain rollback images and restore them
automatically if post-deployment verification fails.
