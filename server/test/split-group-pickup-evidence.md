# Split group suffix and Pick-Up visibility evidence

Completed: `GOB-120921-121097` → **GOB-120921S1-121097**.
The group remains **23 pallets**, comprising S1's 21 and SOB121097's 2.
SOB120921-S2 remains **5 pallets / Pick-Up**, excluded from the delivery pool
and legacy/search feed. Plan 336 revision 39 →
40; audit 23667. Repeating the repair is a no-op.

Three active split groups were inspected. The other two already contain their
split suffixes (`GOA-5680S2-5822-5823`, `GOA-8860S1-8861`). The existing naming
function already retains S1/S2/S10; it was verified and left intact. No unrelated
historical group was renamed.

Tier 3; **spec approval: not obtained (autonomous run)**. The user authorized
the rename, similar-case check and pickup correction, but did not independently
review the [executable specification](split-group-pickup-spec.md).

## Cause and final change

The split definition inherited delivery eligibility from its parent even when the
split's own order header was locally set to Pick-Up. The catalog now checks the
actual order method before pagination. The legacy derived feed excludes the same
pickup split from both global definitions and old snapshots. A parent refresh
cannot bypass those read-time checks, and changing the split back to Delivery
restores visibility without deleting its definition or quantities.

Only `src/dispatch-order-catalog-repository.js` and `src/server.js` were deployed
over a capture of the live image. The prior rollback fix and unrelated workspace
changes were preserved. All 1029 captured source files
match their expected hashes; runtime configuration and other services are intact.

The rename creates the new canonical definition and delivery projection, moves
current plan references and assignment/relation projections together, and retires
the old identity so a stale client cannot recreate it. Source headers, lines,
split definitions, truck, load and stop identities are preserved. The previous
snapshot and private before-image are retained, and an audit records the change.
No NetSuite writes were made.

## Specification and checks

| Criterion / layer | Actual evidence |
| --- | --- |
| Naming, including multiple split indices and CO | SPLIT-NAME examples and 100 generated PROPERTY-NAME cases; suffix-removal mutant killed |
| Similar cases | Real active global/delivery-group audit; three split groups, only the requested rename required |
| Pickup catalog visibility | PICKUP-POOL real PostgreSQL test, stale eligible flag and parent refresh |
| Legacy global/snapshot visibility | PICKUP-LEGACY real query test, with and without the global definition |
| Delivery/Pick-Up reversibility | 20 PROPERTY-PICKUP generated sequences; source snapshot unchanged |
| Rename safety | Rollback rehearsals, shared locks, idle/execution checks, collision guard, fresh fingerprint, before-image, audit and idempotence |
| Initial RED | 3 pickup tests failed behaviorally; the 2 naming tests passed pre-existing behavior |
| Final focused / candidate | 6/6 pass in workspace; 6/6 pass on exact candidate, including existing grouped-pool integration coverage |
| Full suite | 577 files; baseline 2830 pass / 57 fail / 1 skipped; final 2830 pass / 57 fail / 1 skipped; zero new failures |
| Static types | 18,877 existing diagnostics before and after; zero new diagnostics |
| Lint / syntax | Zero repository ESLint diagnostics on changed code/tests/checks/repair; Python tool syntax parsed |
| Changed-line coverage | 10/10 changed lines executed; changed JavaScript branch counters hit; SQL predicates verified with real positive/negative query results |
| Mutation | 5/5 plausible bugs killed; independently 5/5 killed by the property tests alone |
| Suite health | Focused files run separately in seeded shuffled order; 6/6 pass |
| Runtime | Actual deployed pool and legacy queries exclude S2; group is 23 pallets; local and public health 200 |
| Complexity / capabilities | No new production functions or dependencies; only SQL visibility filtering and one identity-set check |

The full suite is not globally green. The unchanged baseline failures and complete
test names are retained in `test-artifacts/split-group-pickup/verification.json`.
The baseline is the preceding task's completed full run; these two backend files
were unchanged between that run and this task's captured before-images.

## Limits and corrections

- The initial rename rehearsal rolled back because PostgreSQL returned revision
  `40` as text. Numeric revision comparison was corrected without changing the
  expected value; the subsequent rehearsal and stale-state challenge passed.
- Static review found one additional diagnostic when checking a field on an
  untyped snapshot. Filtering by the authoritative split identity set removed
  that dependency. Focused, coverage, mutation, candidate, type and full-suite
  checks were rerun on the final source.
- Production concurrency was not stress-injected. Shared locks, activity guards,
  fingerprint refusal, transactional rollback and immediate verification protect
  this specific repair. No broader concurrency proof is claimed.
- Chromium is unavailable in the existing test image. No browser-click result
  is claimed. Actual production naming/legacy function bodies, real database
  queries, deployed code hashes and live HTTP health were verified.
- No dependency audit was needed because the dependency set did not change.
  No commit was made; the dirty workspace was preserved.

## Reproduction and records

`python3 tools/split-group-pickup-gauntlet.py run` creates and migrates a disposable
test database, creates its focused-test clone, reruns the software matrix using
the retained candidate, and removes the test database afterward. The existing
test image and captured before/candidate files are retained prerequisites. `check`
validates completed artifacts. The real incident should not be recreated in
production; `python3 tools/split-group-pickup-rename.py verify` verifies the
already-renamed state without changing it.

Deploy/verify: `python3 tools/split-group-pickup-deploy.py verify`.
Manual mutation script: `tools/split-group-pickup-mutations.py`.
The existing tool versions are recorded in
`test-artifacts/rejected-edit-lifecycle/tool-versions.json` (Node 20.20.2,
espree 11.2.0, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0, TypeScript 7.0.2).

Source hashes: `test-artifacts/split-group-pickup/source-hashes.json`.
Candidate image: `sha256:48b652bfa892dcdc7c0196f4f3044a56bc6a5da95e9d53add820ba1f702b3ce2`.
Release inventory, patch, rollback image and health result: `/home/ubuntu/operatorapp-deploy-backups/split-group-pickup-20260924-v1`.
Private before-image: `/home/ubuntu/operatorapp-investigations/sob120921-20260923/split-group-before-*.json`
(mode 0600), with snapshot archive and audit 23667 retained in the DB.
Raw RED/GREEN, baseline comparison, candidate, coverage, mutation, types, lint,
guard, applied and idempotence artifacts: `test-artifacts/split-group-pickup/`.
