# Driver inactivation

Autonomous implementation of the requested behavior; separate spec approval was
not obtained. Tier 3 because driver authentication and execution are affected.

Acceptance scenarios:

1. Dispatch can deactivate a driver with planned or in-progress jobs. Jobs,
   photos, and completed history remain intact; driver sessions and offline
   grants are revoked. Other roles cannot change driver activation.
2. Inactive drivers cannot log in, reuse a session, start work, or complete work.
   Completion through offline replay or dispatcher assistance has the same rule.
3. Planning, saving, confirming, and editing other work remain available with
   inactive driver assignments. Unknown drivers and unavailable trucks retain
   their existing validation; inactive drivers remain absent from new-driver
   selectors. Existing completed-work protections remain in force.
4. Dispatch can reassign unfinished work to an active driver, after which that
   driver can execute it. Supplying a different login without reassignment must
   not bypass the inactive assignment.
5. Deactivation and execution serialize: once deactivation commits, a queued
   start or completion must fail without recording progress or completion.
6. Setup explains that inactivation is immediate, planning continues, and
   unfinished work needs reassignment before execution.

Failure model: stale sessions (HTTP tests); queued/offline/assisted writes
(repository tests); forged job identities (canonical assignment check);
deactivation racing execution (deterministic database lock test); blocked plan
saves (save/confirm/reassignment tests); history loss (state equality checks).

Use existing Node test runner, PostgreSQL fixtures, fast-check, c8, and ESLint.
No dependencies, schema changes, checkpoint commits, or production-data changes.
Run through docker/run-isolated-tests.sh with automatic teardown and its unique
artifact directory. Persist tests, a reproducible gauntlet, and concise evidence;
discard generated logs, coverage, temporary source copies, and test databases.

The old fleet assertions rejecting known inactive drivers during planning are
superseded by scenario 3. Truck validation is not changed.

Scenario 3 also covers BIN planning confirmation: a driver inactivated after
assignment must not prevent plan confirmation. BIN execution retains its driver
authorization checks. Existing started-stop protections still apply: Dispatch
uses the existing reopen workflow before moving a started stop.
