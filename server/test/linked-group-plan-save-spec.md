# Saving an existing group with a direct pickup

1 October 2026. Spec approval: not obtained (autonomous run).
Tier 3: saved Dispatch plans and direct pickup dependency allocations.

Acceptance criteria:

1. An active persisted SO group, including GOA-9611-9612, may enter a
   plan whose saved snapshot does not contain it. Classic and V2 saves
   accept its unchanged membership and direct pickup before customer drop.
2. The dependency remains linked to the same group and transfer; source line
   identities, allocated quantities, and execution quantities are preserved.
   The transfer is not independently planned.
3. Changing the persisted group's membership, splitting or ungrouping it,
   or grouping a directly linked TO still triggers the structure lock.
   A started normal SO cannot be newly grouped.
4. Active persisted groups provide comparison context only when absent from
   the previous snapshot. Existing snapshot structure still participates in
   validation. Missing or retired groups do not grant an exception.
5. Direct pickup routing and dependency sequencing still run. A delivery
   without its required pickup remains rejected. Saving unchanged existing
   groups does not unlink, recreate, or reallocate the dependency.

Failure model: false structure locks (actual classic/V2 HTTP regression),
unauthorized membership changes (negative HTTP and generated structure tests),
lost allocations (database state comparison), missing pickup (negative HTTP),
stale or retired authority (comparison and retirement tests), partial release
(scoped image overlay, source hashes, health check, retained rollback image).

Setup: use existing Docker Node/PostgreSQL, fast-check, c8, ESLint and
TypeScript. Add tests and reproducible verification scripts, capture an
unchanged baseline and RED before implementation, run focused tests in both
orders and compare the full MBT suite, types and lint against baseline.
Measure changed-line execution and kill three realistic manual mutants,
including the property suite independently. No dependency installs, commits,
migrations or operational production plan writes. Deploy only the scoped
source change over the latest live app image; verify the affected draft using
database-enforced read-only validation. Preserve unrelated workspace changes.

Verification setup amendment: HTTP fixture files retain their test truck rows.
Running the same file twice in one shared database produced duplicate-key hook
failures in the first reverse-order attempt. Preserve that failed log and use
the repository's database-cloning runner for every file in both orders,
coverage and mutation runs. Application behavior and assertions are unchanged.

Live evidence amendment: a newer failed draft contains both GOA-9611-9612 and
CO-GOA-9611-9612. The CO's informational SO cargo references overwrite the
source group's structure identity when its array position comes last. Ignore
SO cargo aliases in CO structure membership, preserving real CO member checks.
Both array orders and adding/removing the informational CO must leave source
delivery structure unchanged. Add property and actual HTTP save coverage.

The user additionally reports that removing unrelated TOB01183 triggers the
same TOB01180 lock. Test that removal through both save endpoints while
preserving the group's direct pickup and allocations.

Verification uses the complete default MBT file list in four independent
shards, with the existing per-file database cloning and 90-second timeout.
Baseline and candidate use the same shard mapping. Preserve the earlier
incomplete full runs from the initial scope. c8 collects changed-file coverage;
the verifier enforces execution of every changed line, instead of applying the
repository's unrelated global 95% module threshold to all of server.js.

Suite-health verification additionally repeats the ten focused files in a
reproducible shuffled order (seed 96119612), with per-file database isolation.
The verification runner includes this step and can replay it independently
using --suite-health.
