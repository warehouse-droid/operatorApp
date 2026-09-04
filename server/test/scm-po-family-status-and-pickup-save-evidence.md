# SCM PO family status isolation and split pickup save evidence

## Outcome

On 2026-09-03 UTC, the exact-identity PO status fix and split-pickup save fix
were deployed as a four-file overlay. `POB03774` was recalculated through the
normal reconciliation service and exact split `3022143273` was repaired through
the normal revision-guarded pickup service.

No NetSuite write, quantity edit, receipt edit, split/unsplit, group/ungroup,
Dispatch plan edit, Driver completion edit, migration, dependency change, or
broad catalog rebuild was performed.

## RED witnesses

Before implementation, the executable regressions demonstrated all three
failures:

- The indexed PO catalog returned a queued source PO as `Completed` when only a
  child split had exact Driver completion evidence.
- PO Split **Save Schedule** sent only the shared schedule request after a
  pickup change; it never called the split-pickup endpoint.
- The backend pickup mutation updated the schedule but did not return its exact
  microsecond schedule revision, so a chained schedule save could self-conflict.

The frontend RED run passed 20/21 tests and failed only the missing pickup
request sequence. The backend RED tests separately failed on the leaked parent
completion and missing `scheduleUpdatedAt` result.

## GREEN and gauntlet evidence

- Final focused release set: 78/78 tests passed.
- PO status policy coverage: 11/11 tests; 100% statements, functions, and lines;
  96.66% branches.
- Status/repository mutation gate: 27/27 mutants killed; sources restored.
- PO Split frontend mutation gate: 21/21 mutants killed.
- Changed-client coverage gate: 23/23 UI tests, 19 changed statements, 18
  changed branches, and 4 required functions covered.
- Broader PO-split regression: 70/70 passed.
- Authoritative schedule/delayed-refresh regression: 44/44 passed.
- Strict focused ESLint, JavaScript syntax, `git diff --check`, and a 12-path
  changed-line secret scan passed.
- The full MBT run passed 437/439 files in an image built before an unrelated
  new projection module existed. After rebuilding from the exact workspace, the
  two affected files passed 5/5 tests. A separate pre-existing TO visibility
  harness still expects an unreconciled completed TO to be completed; it does
  not exercise any of the four release files.
- Whole-worktree typecheck is currently blocked by five implicit-`any` errors in
  the unrelated untracked
  `test/support/run-dispatch-plan-authoritative-projection-mutations.mjs`.
  None of that file or feature is present in this production overlay.

## POB03774 dry run and replay

The rollback-only dry run used `withTransaction(..., { rollback: true })` and
the normal `reconcileScmOrderFamily` service for exact source ID `966875`.
It proposed:

- family ordered `775.9`, received `235.36`, remaining `540.54`;
- `SN1399024`: ordered/received `231.36`, remaining `0`, `Completed`;
- source `POB03774`: ordered `169.54`, received `4`, remaining `165.54`,
  `Partially Done`;
- current active `SN1399025` (`split_po_id -204204911185008`): ordered and
  remaining `375`, `Queued`;
- no reconciliation reason and no blocking review.

The cancelled predecessor `SN1399025` (`split_po_id -207198775041578`) was not
an allocation target. The proposal reported `exactAllocation=false` because
legacy receipt quantities require deterministic inferred allocation; it had no
conflict, conserved all quantity, and produced reconciliation status `ok`.

The committed run and one exact replay returned the same quantities, target
identities, and statuses. The final order state is `Partially Done`/`ok`, and
there are zero open review cases for order-state ID `10487`.

Final live projections:

- SCM `POB03774`: `Partially Done`, `dispatchCompleted=false`.
- Dispatch `POB03774`: `Queued`, `dispatchCompleted=false`.
- `SN1399024`: `Completed` from its own exact Driver evidence.
- active `SN1399025`: `Queued` with `375` remaining.

## 3022143273 repair

The guarded repair required witnessed revision `3`. It advanced only active
split ID `217` to revision `4` and returned schedule revision
`2026-09-03T01:11:37.424601Z`.

The purchase order, shared schedule, split metadata, SCM catalog, and Dispatch
projection now all resolve to:

- pickup: `PERMACON Milton`;
- address: `8375 5 Side Rd, Milton, ON L7J 0A1`;
- status: `Queued`.

Immutable split event ID `7` records `pickup_changed`, expected revision `3`,
applied revision `4`, and the exact Bolton-to-Milton before/after state.
Dispatch audit ID `18348` records the same maintenance repair.

## Refresh, backup, and deployment

Targeted SCM refresh IDs `362`-`365` and targeted Dispatch refreshes for
`3022143273`, `POB03774`, `SN1399024`, and `SN1399025` all completed with empty
errors. No full refresh was enqueued.

- Backup:
  `docker/backups/mbbs-before-pob03774-pickup-fix-20260903T011200Z.dump`
- Backup size: `255654772` bytes; mode `600`.
- Backup SHA-256:
  `2c1edea4c0c9d653b4ae19ed39b2b547a1f7fd6eefa9784b872a689aff913ff3`
- Archive TOC validation: passed.
- Image: `mbbs-operator-app:pob03774-pickup-fix-20260903T010645Z`
- Image digest:
  `sha256:f61582c979cbd124beed9932c59d9453c41bbda4f3f93e6be7422a65ecf6e336`
- App and webhook worker run the same image, with zero restarts.
- App health returned HTTP 200; post-deploy logs contain no errors.
- The database postmaster start time remained
  `2026-08-14 13:14:47.914121+00`.
- Live PO Split HTML serves
  `dispatch-scm.js?v=20260903-po-status-pickup-v1`.

Rollback uses the preserved base image and the release directory's
`docker-compose.rollback.yml`; the database backup predates both exact data
repairs.
