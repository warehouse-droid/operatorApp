# Repeated pickup visits in one Dispatch load

Status: approved through the user's repeated-pickup plan and implementation request.

Assurance tier: Tier 3. This feature changes an active route while Driver PWA
execution can race with a dispatcher save.

## Setup and authorization

- Use the repository's existing Node test runner, `c8`, ESLint, PostgreSQL test
  harnesses, Playwright checks, source-state script, and secret scanner.
- Add no runtime or development dependency and no database migration.
- Do not deploy.
- Capture production-like history only in a repeatable-read, read-only
  transaction. Sanitize identifiers and exclude names, addresses, photos, and
  raw payloads before writing a replay artifact.
- Inject late orders only into cloned, sanitized plans. Any Driver records
  created by replay must be enclosed in a forced rollback transaction.
- Preserve every unrelated working-tree change; do not create checkpoint
  commits in the shared dirty worktree.

## Failure model

| Failure | Required detector |
|---|---|
| A completed pickup silently acquires a late order | immutable-prefix unit and concurrency tests |
| One order is loaded twice, or not loaded before delivery | allocation validator and property tests |
| A route edit changes the destination while a Driver travel job is active | active-travel boundary test |
| Two visits at the same yard collapse into one Driver job/photo record | Driver job materialization integration test |
| A manual split moves a partial line/quantity | whole-order split tests and UI contract |
| Legacy snapshots become ambiguous when a second same-yard visit appears | migration/error tests |
| A stale browser overwrites a newer split | revision/digest command concurrency test |
| Historical replay changes production or source records | read-only capture and rollback assertions |
| Normal unstarted pickup grouping regresses | ordinary grouping regression test |

## Executable scenarios

### RP-01 — normal automatic grouping remains unchanged

Given two unplanned orders require yard 3445 and their shared 3445 pickup has
not started, when the second order is added to the load, then one pickup visit
contains both order references and both deliveries remain after it.

### RP-02 — a sealed yard visit creates a repeat visit

Given order A's 3445 pickup is complete and the Driver is travelling to later
vendor/direct-ship work, when a newly synchronized order B for the same future
customer address is added to that load, then pickup A is byte-for-byte
unchanged, a new opaque 3445 pickup allocated only to B is inserted after the
travel destination and before B's delivery, and B's delivery is adjacent to
the existing future delivery.

### RP-03 — a completed customer visit produces a second customer visit

Given the matching customer delivery has started or completed, when a late
order is added, then the new pickup and a second delivery are appended after
the protected route prefix.

### RP-04 — manual 3+2 whole-order split

Given one future 3445 pickup contains five orders, when a dispatcher selects
two whole orders and chooses the latest legal route gap, then the source visit
contains the other three, a second future pickup contains exactly the selected
two, every order is allocated exactly once, and no item quantity is changed.

### RP-05 — active work is immutable

Given a pickup is in progress or complete, when a command changes its type,
location, order allocation, driver/truck assignment, or position in the
executed prefix, then the save fails with `DISPATCH_ACTIVE_LOAD_LOCKED` and no
plan revision is written. Derived timing-only changes do not fail this check.

### RP-06 — legacy snapshot materialization is safe

Given an untouched legacy load has no `pickupVisitSchemaVersion`, ordinary
saves preserve that load byte-for-byte instead of applying a new global
validation rule to old route shapes. When a load first uses repeat-pickup
behavior, it opts into `pickupVisitSchemaVersion: 1`: one legacy pickup may be
materialized from its matching deliveries, while two same-yard pickups with no
prior unambiguous allocation fail with `DISPATCH_PICKUP_VISIT_AMBIGUOUS`
instead of guessing. Other unmarked loads in the same historical plan remain
unchanged.

### RP-07 — each repeat visit has independent Driver PWA evidence

Given two 3445 pickup stops with different stop IDs and disjoint order refs,
then Driver route materialization emits two pickup jobs with distinct IDs,
scoped order manifests, statuses, and photo evidence. A safe plan-saved event
may refresh future jobs automatically; no readiness handshake is introduced.

### RP-08 — dependency, timing, capacity, and tooltips use visit scope

Given repeat pickups at one yard, then each pickup's footprint, weight,
dependency manifest, statistics, tooltip order list, and sequence validation
use only that visit's `orderRefs`, not all load orders from that yard.

### RP-09 — atomic stale-command rejection

Given two browsers submit pickup split deltas from the same base revision and
digest, then one may commit and the stale one fails with `STALE_DISPATCH_PLAN`;
the winning allocation remains valid and no duplicate visit is created.

### RP-10 — seven-day activity replay with injected revisits

Given every Dispatch plan state and Driver PWA activity row captured for the
last seven complete Toronto-local calendar days, when the corpus is sanitized,
replayed chronologically, and a fake late same-address order is injected into
each eligible cloned active load, then every source row is accounted for,
executed prefixes remain unchanged, every injected order receives one legal
repeat pickup and delivery, Driver jobs are independently scoped, and the
source database row counts/digests are unchanged. Plans without enough route
or activity evidence are reported explicitly, not counted as passes.

## Negative constraints

- Do not change completed or in-progress stop IDs, locations, allocations,
  driver/truck assignment, statuses, timestamps, or photo evidence.
- Do not support partial line or quantity allocation between pickup visits.
- Do not merge non-adjacent deliveries or same-address pickups into one visit.
- Do not mutate NetSuite, source Dispatch plans, or live Driver records during
  replay.
- Do not deploy, add a readiness handshake, or add a dependency/migration.
- Existing automatic grouping, PO multi-destination, direct-pickup dependency,
  route timing, history, offline Driver, grouping, split/unsplit, and CO tests
  must have zero new failures.
