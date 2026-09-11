# Driver live-route prefix lock specification

Status: approved in conversation on 2026-09-10.

## Intent

Once a Driver starts work, the saved Dispatch route before and through that
work is immutable. Dispatch may continue editing only the unexecuted suffix.
The Driver PWA must never fall back to an older route position after a plan
revision.

## Executable scenarios

1. **Empty preceding load is locked.** Given Mike is executing Load 2 Stop 2,
   when Dispatch deletes, moves, renames, retimes, or reassigns an empty Load 1,
   the save fails with `DISPATCH_ROUTE_PREFIX_LOCKED`; the plan revision and
   snapshot remain unchanged.
2. **Earlier populated work is locked.** Removing or changing an order, stop,
   location, instruction, or allocation in a load before the boundary fails
   with the same conflict.
3. **Current prefix is locked.** The current load identity, assignment, lane
   position, inbound travel context, and every physical stop through the
   current job cannot change. Later stops in that load and later loads remain
   editable when they do not alter the prefix.
4. **The boundary is monotonic.** With no in-progress job, the latest completed
   route job remains the boundary. Completing another job can only advance the
   boundary; it cannot unlock prior route data.
5. **Every save path is covered.** Incremental commands, full saves, force
   saves, undo/redo, snapshot restore, and repository-mediated automated plan
   writes all apply the same check. A force flag is not an override.
6. **The active Driver job is sticky.** If an assigned route job is in progress,
   `/api/driver/next-job` returns that physical visit regardless of an earlier
   incomplete generated job. A request cannot start a second unrelated job.
7. **Selection never moves behind execution.** With no active job, online and
   offline selection choose the first incomplete job strictly after the latest
   completed boundary. Passed pending work is retained as a Dispatch exception,
   not represented as completed Driver evidence.
8. **Broken active identity fails closed.** If an in-progress job no longer maps
   exactly to the confirmed route, the PWA receives an explicit route conflict;
   it does not silently select the first pending job.
9. **BL42349 replay.** While `3022191978` is active, the recorded attempt to
   remove `SN1399919`, delete/resequence the preceding load, and generate a new
   `12441 -> UNILOCK Gormley` travel job is rejected. Mike remains able to
   complete `3022191978` with its photos and no unrelated second job starts.
10. **No-activity compatibility.** Before any Driver activity exists, ordinary
    Dispatch planning and first-job selection are unchanged.

## Failure model and required evidence

- A plan mutation races a Driver start/completion: exercise the shared planning
  lock in an integration/concurrency test and prove only a serialized valid
  outcome commits.
- A load with no physical stops changes the active load's predecessor: cover an
  empty-load deletion/reorder regression, not only stop-level fingerprints.
- A synthetic travel or truck-switch identity changes: cover active and
  pre-boundary synthetic jobs explicitly.
- Consolidated physical visits create several legitimate records: treat one
  visit as one execution group; do not misclassify it as multiple active work.
- A stale/legacy state contains unrelated active records: choose no new work,
  emit attention/audit evidence, and never create another active record.
- Online and cached/offline projections disagree: run the same cursor cases
  through the server selector and browser projection contract.
- A rejected save partially writes state: integration tests assert unchanged
  revision, snapshot digest, assignments, and job rows.
- A failure is silent in production: assert the structured conflict and audit
  or application event payload.

## Invariants

- No warning or administrator override is introduced.
- Actual status, evidence photos, and live forecast updates remain permitted;
  they do not rewrite the locked plan.
- Existing dependency, rest, DVIR, truck-switch, photo, location, offline
  idempotency, and exact-assignment gates remain fail-closed.
- No existing production or historical data is repaired automatically.
- No database migration or third-party dependency is required.
- The Driver shell advances atomically to cache v41 with asset token
  `20260910-route-prefix-cursor-v1`; the client/server protocol version remains
  `2026.08.12.3`.
- No deployment is authorized by this work.

## Setup and gauntlet

- Use the repository's existing Node, PostgreSQL, Docker test environment,
  ESLint, TypeScript, c8, and Playwright dependencies; add no packages.
- Add focused unit/property/adversarial/integration/concurrency/browser-contract
  tests, a deterministic BL42349 replay, a persisted manual mutation runner,
  and one feature gauntlet entry point.
- Run the focused RED test before implementation, then focused GREEN tests,
  the feature gauntlet, the complete MBT suite, the baseline harness suite, and
  the complete E2E suite. Record any pre-existing failures without weakening
  tests.
- Do not create checkpoint commits because the user did not authorize commits;
  preserve all pre-existing working-tree changes.

## Compatibility clarification (append-only, 2026-09-10)

- New cross-load/predecessor conflicts use `DISPATCH_ROUTE_PREFIX_LOCKED`.
  Existing edits rejected by the older same-load physical-prefix rule retain
  `DISPATCH_ACTIVE_LOAD_LOCKED`, so current clients and operational tests do not
  lose their established error contract.
- A legacy state with more than one unrelated but still-mapped in-progress job
  selects the oldest active route group for completion, reports
  `DRIVER_MULTIPLE_ACTIVE_ROUTE_GROUPS` as attention, and cannot start a new
  pending job. An active job absent from the confirmed route fails closed with
  `DRIVER_ACTIVE_ROUTE_CONFLICT`.
