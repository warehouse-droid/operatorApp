# Global order pool and dependency preview evidence

Date: 2026-08-28 UTC

Spec approval: not obtained before implementation; the requested production repair proceeded autonomously from the user's explicit examples and safety constraints. The executable specification is `test/dispatch-global-order-pool-dependency-preview-spec.md`.

## RED evidence captured before implementation

The focused disposable-database run executed eight surrounding tests. Six safety tests passed and these two expected regressions failed:

1. `a grouped order stays globally searchable while its CO and final-delivery assignments remain independent`
   - Expected one `GOB-119005-119006` result in the next-date order pool; received zero.
2. `cancelled dependency with zero execution and CO-only Driver activity does not block a new TO link`
   - Expected `allowed: true`; received `allowed: false` with `DEPENDENCY_EXECUTION_STARTED`.

No application source had been changed when this RED proof was captured.

## Implemented contract

- Delivery-group definitions are persisted in a global projection; route assignments remain date/plan-specific.
- An active global group replaces its raw member cards in the pool and remains exact-searchable across plan dates.
- An unassigned global group is not silently saved into an unrelated plan. Assignment materializes only when the group is placed on that plan.
- A canonical owner may retire a group by ungrouping it; an unrelated or stale snapshot may not retire or reclaim it.
- A cancelled dependency with zero line progress is not execution.
- Loaded, delivered, or locally received progress still blocks, even on a cancelled dependency.
- Driver activity matching `CO-TOB00991` is not exact activity for `TOB00991`; exact `TOB00991` activity still blocks.

## GREEN and gauntlet evidence

Final single-run command:

```text
bash server/tools/global-order-pool-dependency-preview-gauntlet.sh
```

Result: exit 0.

- Focused integration/property: 9/9 passed.
- Browser save-coordination contract: passed.
- Dispatch planner optimization: 73/73 passed.
- SCM dependency-management regression set: 51/51 passed.
- Migration upgrade/readiness: 7/7 passed, including schema-101 upgrade and migration rerun idempotency.
- Coverage: 74.04% statements/lines across the focused modules; 9/9 changed functions covered.
- Mutation: 6/6 deliberate regressions killed (100%); source hashes restored.
- Syntax, zero-warning ESLint, and TypeScript checks: passed.
- Isolated full suite: 428 files / 2,117 tests, runner passed.
- Changed-line secret scan: 16 paths checked, no high-confidence findings.

## Production deployment evidence

- Pre-migration backup: `docker/backups/mbbs-before-global-pool-dependency-preview-20260828T225253Z.dump`
  - Size: 238,599,204 bytes
  - SHA-256: `cdc786c8819f13f84170efc68407c98a441378abdb131442772b4d412effaeec`
  - `pg_restore --list` validation: exit 0
- Prior live image: `sha256:363befb79b39392aba7ffdeb716d186292f887c41fef110494af0e9d67687d56`
- Rollback tag: `mbbs-operator-app-app:rollback-pre-global-pool-dependency-20260828T225253Z`
- Release image: `sha256:22825c1fdb0e9f4aeef70527abb229c22c881b0a7506dd77b5e844268dc68e8d`
- Release tag: `mbbs-operator-app-app:release-global-pool-dependency-20260828T225253Z`
- Migration `190_dispatch_global_order_groups.sql` applied at `2026-08-28 22:55:00.409962+00`.
- App-only Compose recreation reached healthy in 7.09 seconds. Database and webhook-worker containers retained their original start times.
- Startup log: assignment projection ready; server listening; no startup/runtime error.

## Live acceptance evidence

`GOB-119005-119006`:

- Exact SO pool search returns exactly one global group.
- Members: `SOB119005`, `SOB119006`.
- Global source: plan 261 / 2026-08-28.
- The group is unassigned and therefore available on 2026-08-29.
- Searching `SOB119005` returns the group rather than a duplicate raw member.
- Existing `CO-GOB-119005-119006` remains independently assigned to plan 261 / 2026-08-28, truck BC71838, Load 5, driver Dao.

`SOA07787` to `TOB00991`:

- Production dependency 231 remains `cancelled` with three lines and zero loaded, delivered, or locally received quantity.
- Read-only production preview returns `allowed: true`, `effectiveAction: link_to`, and an empty blocker list.
- Affected refs are exactly `SOA07787` and `TOB00991`; a CO-prefixed ref is not treated as exact TO execution.

State-integrity comparison before migration and after live acceptance:

- Plan 261: revision 128, orders MD5 `afd09c171357186b905827ab49c43b03`, trucks MD5 `cb31727a5745fe197d196ef4ed7d6032`.
- Plan 262: revision 20, orders MD5 `1ecf7fb80e57b0f67405376d6fbb7351`, trucks MD5 `afee908a22912b31f33e7bb8eade97cb`.
- Dependency 231 timestamps/status/progress were unchanged.
- No plan snapshot or existing CO assignment was rewritten by migration or verification.
