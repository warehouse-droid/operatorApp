# SOV dispatch implementation evidence

The implementation includes SOV in the regular dispatch SO feed and registers
NetSuite location **4**, display code **195**, at
**195 Milner Ave Unit 5, Scarborough, ON M1S 4P4**. PO, TO, inventory, Operator,
returns, and MBT billing scope remain unchanged.

The release image is `mbbs-operator-app:sov-dispatch-20260914-v1`. It overlays
only 12 changed runtime files and the maintenance command onto the running app
image. The original workspace matched that image except for an unrelated test
harness, which is excluded from the release. Existing worktree changes were retained.

## Acceptance coverage

| Behavior | Executable evidence |
| --- | --- |
| Ordinary eligible SO discovery includes location 4; other feeds retain four yards | SOV-01, SOV-13 |
| Exact address/code/ID, saved setup upgrade, private backup, repeat execution | SOV-01, SOV-02, SOV-11, SOV-23, SOV-25 |
| Loose physical stock gains a native pickup; fees and alternate allocations retain normal behavior | SOV-03, SOV-04, SOV-09, SOV-10 |
| Completed/started work and active travel are protected, including unknown destinations | SOV-05–07b, SOV-12, SOV-15, SOV-15b, SOV-18, SOV-19 |
| Existing pending visits are shared without duplicate pickups or changed completed allocations | SOV-06, SOV-08, SOV-10, SOV-19 |
| Rollback, stale fingerprint refusal, snapshot history, backup, driver address, repeat repair | SOV-14, SOV-17, SOV-20 |
| Terminal and customer-pickup orders are excluded; fresh NetSuite eligibility controls repairs | SOV-16, SOV-20, SOV-24 |
| Historical compatibility cannot remove recorded pickups; snapshot restoration preserves started routes | SOV-21, SOV-22 |
| Grouped and split SOV cargo and canonical source eligibility | SOV-24 |

Run `bash server/tools/sov-dispatch-gauntlet.sh` from the repository root. It uses
an isolated PostgreSQL 18 container, a separate database for focused tests, and
the existing `mbbs-retired-confirm-test:20260914` development image. The baseline
can be reconstructed from `test/support/sov-dispatch-baseline.patch`.
Artifacts live in ignored `server/test-artifacts/sov-dispatch/final/`.

Recorded tool versions: Node 20.20.2, fast-check 4.9.0, ESLint 10.8.0,
TypeScript 7.0.2, c8 12.0.0. No dependencies changed. The final evidence checker
records a SHA-256 manifest and changed-runtime-line coverage report, and rejects
new type/lint errors or unexpected regression failures.

Final results: **28/28 focused tests**, **22/22 live-route protection tests**,
and **4/4 existing dispatch harnesses** passed. Both property tests use fixed
seeds (110 generated cases altogether). All **5/5 manual mutants** were killed
by the focused suite and independently by the property tests. All 28 focused
tests also passed with their file execution order reversed. c8 reported no
uncovered executable changed lines across **283 changed runtime JavaScript lines**.
The full suite completed **462/462 files**, with exactly the two baseline failing
files below and no new failures. Secret scanning and the final evidence checker passed.

The full MBT suite has two pre-existing failing files:
`test/mbt/infrastructure/p3-gauntlet-contract.test.js` (browser pool lifecycle)
and `test/mbt/infrastructure/production-runtime-contract.test.js` (omit-dev runtime
gauntlet contract). The existing pickup regression suite also retains its original
`RP-05 active travel protects its destination while allowing work after it` failure.
Each was reproduced on the source captured before this change. Static checking
retains 233 existing type errors and 28 existing lint errors.

Initial negative tests exposed the missing yard, unguarded browser repair, strict
legacy-load validation, completed-assignment rebuilding, and repeated-repair
allocation metadata. Assertions were retained while those behaviors were fixed.
An early focused run shared the full suite's template database and was disconnected
by its database-cloning mechanism; the final runner uses separate databases.
The first candidate yard mutant was redundant with the existing address catalog;
the final mutation set tests five behavior-changing faults and verifies the
unmodified suite before and after mutation. Browser tests execute actual extracted
functions; they do not claim DOM or mouse-driven end-to-end coverage.

## Production rehearsal and rollout status

Read-only NetSuite discovery confirmed both the header and two stock lines on
**SOV02222** use location 4/code 195. Its status is Billed and delivery method is
Pick-Up; it is not reopened or imported as an active Delivery order.

**SOV02345** and **SOV02333** were the two eligible Delivery orders. All 34 item
lines use location 4/code 195. The maintenance command successfully refreshed
those orders and catalog entries on an isolated production copy. Repair discovery
found no eligible pending SOV stop to change: SOV02345's recorded delivery was
already in progress, and historical saved SOVs were outside current eligibility.
Future pending SOVs receive normal pickup handling; the maintenance command also
supports pending suffixes of active loads.

The release passed an isolated HTTP startup check (`/health` and `/dispatch.js`
both returned 200, and the dispatch asset contains the Milner address). A private
database backup, setup backup, current image identities, and repair manifests are
stored under `backups/sov-dispatch-20260914/`. A read-only comparison verified all
25 saved plans containing SOV references and all four recorded SOV driver jobs
were unchanged in production.

**Deployed 2026-09-15 at 00:40 UTC, following the user's explicit approval.**
The app and webhook worker both run `mbbs-operator-app:sov-dispatch-20260914-v1`
(image SHA-256 `1b58932eeb0c89ce3c4a2037be702c22b782721fac51c916f8d4c32d641f45f7`).
All 13 shipped files matched the validated source. Both services remained running
with zero restarts; app health and the updated dispatch asset returned HTTP 200.
The Dispatch page uses the `sov=20260914-v1` browser cache version.

The saved setup now includes location 195 exactly once, with internal ID 4 and
the full Milner address. Fresh NetSuite discovery again identified SOV02345 and
SOV02333. Production refresh updated both orders, their 34 item lines, and both
catalog entries. The approved repair command checked 25 saved plans and found
no eligible pending pickups to add. SOV02345 on plan 324 was protected because
its delivery had started. A post-deployment comparison confirmed all 25 saved
plan manifests/routes and all four recorded SOV driver jobs were unchanged.
SOV02222 remained excluded as Billed/Pick-Up. No NetSuite transaction writes
were performed.

Fresh backups, setup rollback data, discovery data, and before/after fingerprints
are in `backups/sov-dispatch-20260915-rollout/`. Deployment results are in
`server/test-artifacts/sov-dispatch/deployment-20260915/`.

For subsequent maintenance, run a new `discover` before `refresh --apply` and
`repair --apply`: manifests expire after 15 minutes. Apply uses the current
plan/activity fingerprint and requires a private per-plan backup.
`tools/sov-dispatch-postcheck.mjs` provides a read-only route/activity comparison.
