# BIN planning — implementation specification

Authorization: user instructed “Implement the plan”; subsequently emphasized that
the Dispatch planning page must continue working. The shared date, drivers and
single editor are user requirements. The acceptance scenarios below translate
that authorized scope into executable checks; this detailed list was not
separately reviewed by the user.

## Acceptance scenarios

1. **Shared editor**: MBT and Dispatch use the same daily plan and date lease.
   A second session cannot mutate that date; expired/missing leases, stale plan
   revision/digest, stale visit revision and reused command IDs fail atomically.
   Navigation in one tab preserves the existing Dispatch session and lease.
2. **Preserved counterpart**: ordinary Dispatch saves, including V2 commands,
   work when unchanged BIN assignments coexist, even with MBT disabled. Generic
   edits cannot change BIN stops, driver, truck or scheduling. MBT mutations
   preserve ordinary orders/loads. Both pages display counterpart work read-only.
3. **BIN planner**: `/mbt/planning` offers the eligible unassigned pool, searchable
   and paginated beyond 100 visits, driver lanes with times, BIN load creation and
   editing, compatible truck/driver assignment, whole-visit moves and sequencing
   with buttons and drag/drop, cancellation and a visit/history drawer. A blocked
   visit remains visible with its reason without failing the feed.
4. **Pool lifecycle**: delivery completion releases the next visit of that service
   line to the pool only. Its requested window is preserved. No date, driver,
   truck, load, or reservation is automatically assigned. Front Desk commercial
   edits remain available for eligible unassigned visits.
5. **Cancel/replan**: cancel an October 5 assignment, then explicitly assign the
   visit on October 6, using each date's lease independently. Cancellation is
   unplanning, not service cancellation. Started visits can be unplanned before
   completion. Preserve steps, photos, scans, physical custody and history;
   replanning resumes remaining work. Completed visits cannot be unplanned.
6. **Completion race**: cancel and driver completion serialize; withdrawn work
   leaves active routes/occupancy. A late offline event for a withdrawn generation
   requires review, while an already accepted replay remains idempotent.
7. **Driver publication**: confirming the whole shared day authorizes exactly the
   current BIN driver assignments without a manually seeded pilot permission.
   Assignment generations and release/revocation history persist. Changed/new
   assignments require confirmation; unchanged released assignments survive
   unrelated edits. Feature gates remain effective.
8. **Planning correctness**: enforce whole-day driver/truck timing conflicts and
   peak physical BIN occupancy/weight. Sequential complete visits fit a one-slot
   truck; simultaneous incompatible use fails. Reservations, audit, revisions,
   digest and read projections commit together; refresh events follow commit.
9. **Real execution**: exercise authorized HTTP endpoints and browser navigation,
   keyboard assignment, lease conflicts, searching/pagination and ordinary
   Dispatch regression behavior against a disposable database.

## Failure model and checks

- Lost updates / two editors / cancellation-completion races: database concurrency
  tests, revision and lease adversarial checks.
- Partial commits / leaked reservations / corrupted custody: rollback tests,
  durable state assertions and migration rehearsal on a disposable database.
- Driver disclosure / stale offline execution: exact authorization and generation
  checks, replay/revocation integration tests.
- Ordinary Dispatch regression: both save paths with BIN present, disabled MBT,
  unchanged BIN projection and protected ordinary counterpart assertions.
- Missing visits / split groups / capacity errors: pagination tests, whole-visit
  properties, sequential and peak capacity examples and manual mutants.
- UI not connected to real behavior: browser plus actual endpoint execution.

## Setup and invariants

Use existing Node, PostgreSQL, Playwright, fast-check, TypeScript and ESLint tools
in the existing local test image. No new dependencies, commits or deployment.
Add an isolated internal Docker network and disposable test database with unique
task-owned names. Do not access production or other test databases. Preserve all
unrelated work in this dirty checkout. Add an additive migration after 234,
task-specific tests, reproducible gauntlet scripts and an evidence report.
Business dates remain America/Toronto. Front Desk owns pricing and commercial
creation. Concrete and mixer recipes are out of scope. No external writes.

Tier 3 old-coder verification applies. Record RED runs, regression baseline,
types/lint, changed coverage, property tests, manual mutations, concurrency,
browser/API execution, source hashes and any unverified limits in the evidence.

## Compatibility expectation update

The prior disabled-BIN tests required ordinary Dispatch saves and confirmation
to fail merely because unchanged BIN work existed. That conflicts with the
user's explicit instruction to keep Dispatch usable. Retain their zero-write
assertions for BIN edits/insertion/deletion/restoration, using the new
`MBT_BIN_PLANNING_REQUIRED` response. Replace the ordinary-confirm rejection
with assertions that it succeeds and preserves every BIN stop. Dispatch no
longer discovers BIN capability or requests its pool; its ordinary initial
render must complete with no MBT request at all. Confirmation remains gated.

The updated HTTP confirmation fixture checks a persisted ordinary load edit.
An initial extra assertion that an unplaced SO remains in the active snapshot
was incorrect: Dispatch intentionally stores placed orders only. That source
pruning behavior remains unchanged; the test requires confirmation success,
the ordinary load edit, and byte-for-byte preservation of BIN stops.
