# Stable weights and non-blocking weight changes

User request: weight differences must not block saving, and an unchanged order
must not acquire a different weight. Incident: September 29 plan 341, Li /
CC46868, GOB-121261-121262, 8784.966199999999 versus 8784.966 lb.

Spec approval: not obtained separately (autonomous run). This implements the
user's explicit weight policy. Tier 3: changes affect protection of completed
work. No source orders, active production plans, recovery backups or driver
records will be rewritten by this task's verification.

Acceptance scenarios:

1. Unchanged saved group and child weights use the same three-decimal total as
   the source lookup after repeated plan reads and a successful save. The
   incident's group remains 8784.966 and its child remains 7744.966.
2. Weight-only differences in orders, children, items and physical stops
   (`weight` / `dropWeight`) pass executed-work validation, for both in-progress
   and completed jobs, irrespective of the size of the weight difference.
3. An authenticated save containing a weight-only stop update succeeds and
   retains the driver's recorded job details and photo evidence.
4. Quantity, pallet, identity, destination, stop timing and load sequence edits
   on executed work remain blocked. Weight changes cannot hide these edits.
5. When another field causes a conflict, neither group/child weight nor stop
   weight appears as a reason for rejection. Real conflict details survive.
6. Weight changes remain excluded from source review notices; existing genuine
   source notices and acknowledgements retain their behavior.

Failure model and checks:

- False save rejection: exact incident, generated weight/stage/alias cases,
  authenticated HTTP save, read-only production replay.
- Weakened historical protection: negative property cases, existing executed
  route/quantity/address/concurrency suites, deliberate regression mutations.
- False weight drift: actual database plan reads and round trips; nested group
  totals and nonzero item quantity updates remain correctly calculated.
- Accidental history rewrite: byte-for-byte job evidence checks; live replay is
  a READ ONLY transaction and makes no planning write.
- Unrelated regressions: full adjacent executed-work suite in shuffled order,
  compared with the pre-change source baseline without weakening assertions.

Setup: existing isolated Docker test image and disposable PostgreSQL, Node's
test runner, fast-check, ESLint, TypeScript and c8. No added dependencies, schema
changes, public API changes or commits. Tests/checker/replay and evidence are
kept in this repository. Source hashes and a task-only patch identify the
implementation independently of the repository's existing uncommitted work.

## Clarification after the user's sequence question

Load 3's last drop was in progress (20:10–21:25 UTC) at the 20:23–20:24 failed
saves. The physical load order did not change; [0, 1, 3] became [0, 1, 2].
Scenario 4's sequence protection means actual route order, not numeric gaps.
Add scenarios: closing numeric gaps without moving any load must pass;
reordering loads/stops strictly after the executed boundary must pass; moving,
removing or inserting before started work must still fail. Compare relative
lane position in the whole-load guard and rely on the existing prefix identity
check for boundary-load order. No automatic rewrite of past timing is added.
