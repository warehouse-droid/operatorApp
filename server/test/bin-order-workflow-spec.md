# BIN order workflow specification

Approved scope: the user approved the conversational implementation plan and
its workflow diagrams, then corrected references to the BIN prefix. This file
makes those criteria executable. Tier 3: custody, concurrent assignments,
public driver contracts, offline retries and existing billing ownership.

## References

- One globally unique, immutable, minimum-five-digit number per rental/service
  line. Sequence gaps are acceptable; reuse or renumbering is not.
- Rental 1 initial delivery: BIN00001D.
- Final pickup: BIN00001C; dump: BIN00001C-DP; yard return: BIN00001-R.
- Exchange 1 parent: BIN00001X-1; delivery: BIN00001X-1D; pickup:
  BIN00001X-1C; dump: BIN00001X-1DP.
- Consistent default for an exchange's yard return: BIN00001X-1R.
- A collection feeding rental 2 uses that rental's existing delivery reference
  BIN00002D. Linking work does not allocate another rental number.
- Backfilled readable references must not change historical visit IDs, stop
  IDs, immutable evidence, or issued offline snapshot hashes.

## Executable acceptance cases

1. Delivery shows its selected physical bin and last confirmed source. Planned
   predecessors show a clearly identified future source. A bin already aboard
   the assigned truck does not acquire a duplicate physical pickup.
2. Every rental has initial Delivery and final Collection. Each Exchange owns
   separately schedulable delivery and collection parts.
3. Collection includes pickup and dump, followed by an approved-yard return or
   one linked Delivery (initial or exchange) of the same physical bin and exact
   target bin type. Required scan/photo/receipt evidence remains enforced.
4. Same-bin collection-first: pickup, dump, deliver to the original site on the
   same America/Toronto calendar day. Dump is required before delivery.
5. Different-bin collection-first: replacement delivery follows confirmed
   pickup, on the same local day; the old bin's dump/onward work remains open.
6. Delivery-first: old-bin pickup follows replacement delivery, even days later.
   Another exchange may start while older collections remain pending. Every
   collection retains its original physical asset.
7. Final Collection picks up the current asset; older obligations survive and
   prevent operational closure until all recovery routes finish.
8. Linking a Collection to a Delivery creates one physical destination action,
   with explicit prerequisite completion rather than a cyclic order dependency.
9. Planning checks source, type, capacity, chronological feasibility, custody,
   reservations and same-day promises; execution checks actual prerequisites.
   A late real-world completion is recorded and flagged instead of discarded.
10. Changing trucks requires recorded custody. Stale plans, mismatched bins,
    circular reuse, simultaneous exclusive claims and silent redirection fail.
11. Duplicate and late offline events cannot double-move or double-charge bins.
    Cross-device prerequisites must be durable before dependent execution.
12. Front Desk and BIN Planning expose human references, exchange sequence,
    separate schedules, dump/destination choices, current and pending bins.
    Driver list and job details show the action's bin and actual address.
13. Existing legacy visits remain compatible; new/unissued work can use the
    new workflow, and issued work is never silently rewritten.
14. Split execution parts preserve the existing parent billing owner and rate
    calculations. Shared movements generate no duplicate billable service.

## Failure model and verification

- Sequence races, double bookings and double events: real transaction race and
  idempotency tests, unique constraints, atomic rollback checks.
- Wrong bin or location, skipped dump, premature closure: realistic
  driver/planning integration scenarios and property invariants.
- Stale offline snapshots and handoffs: old-schema contract regression and
  replay/custody cases.
- Changed route or hidden outstanding work: browser tests using the actual
  Front Desk, planner and driver projections.
- Migration/backfill and rollback compatibility: disposable database upgrade
  checks; no production database used for tests.
- Regression baseline, lint/types, changed-line coverage, property tests,
  3–5 deliberate mutants and adversarial scenarios. Record exact results and
  skipped layers with reasons in the evidence artifact.

## Setup and preservation

Use existing Node, Playwright, TypeScript, ESLint, c8 and fast-check toolchains.
No new runtime or development dependencies. Capture the current dirty runtime
source as a baseline; preserve unrelated changes and avoid a broad checkout or
commit. Persist tests, reproduction tools and evidence in established test,
tools and test-artifacts directories.

All test containers use the standard isolated Compose setup, mbbs-tests.slice,
bounded memory/CPU/PIDs/tmpfs and disposable labels. Register teardown before
creation; use down --volumes --remove-orphans and verify docker ps, docker ps -a,
project networks/volumes, and production health on every exit.

No production mutation or deployment is needed to establish the implementation
and evidence. A release must preserve the live runtime and apply only the
reviewable feature changes and additive migrations.

## Clarifications from implementation review

These extend cases 1, 7, 8, 10 and 13 without changing their behavior:

15. A linked receiving Delivery retains the selected physical bin before that
    bin is collected, and labels its future source “After dumping”. Its source
    Collection keeps its asset reservation until the shared Delivery finishes.
16. A legacy driver job completing after upgrade updates the rental's current
    bin from committed physical state without rewriting its frozen instructions.
17. Retargeting a draft final Collection or a shared onward Delivery must fail
    atomically if either affected destination already has assigned or issued
    work. Existing references, assets and instructions remain intact.
