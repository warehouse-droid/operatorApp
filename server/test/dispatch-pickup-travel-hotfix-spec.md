# Pickup editing and travel reopening hotfix — 2026-09-11

Spec approval: not obtained (autonomous run). The user clarified that editing
locks when the driver starts the specific pickup, not when the load or travel
starts, and requested an urgent production hotfix.

Acceptance criteria:
1. An unstarted pickup permits adding orders and editing cargo while travel
   toward it is in progress or complete, including inter-load travel without a
   target stop ID and travel toward a later pickup in the same load.
2. Started/completed physical stops and preceding route history remain protected;
   current driver/truck assignments remain protected.
3. Recorded travel appears in the existing reopen screen and can be restarted or
   reopened only with the existing state-hash, audit, newest-first, offline-event,
   rest and foreground-action checks. Original evidence remains in corrections.
4. Rest and truck-switch records remain outside the stop-reopen action.

Failure model: premature cargo locks; rewriting performed pickups; stale or
duplicate reopen; lost timestamps/audit evidence; unrelated code in the release.
Use regression tests, rollback database integration, source hashes and a release
based on the exact running image. No dependencies, migrations or data repair.
The urgent hotfix uses focused regression/static/runtime checks before deployment;
the entire repository gauntlet is deferred to avoid delaying active planners.

The existing retry response adds `exactRetry: true` to the stored result; the
integration assertion must preserve this documented API behavior. This corrects
the initial test expectation without changing the implementation or weakening
the requirement for exactly one correction and audit entry.
