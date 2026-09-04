# Dispatch plan authoritative order projection specification

Status: approved for implementation by the dispatch request on 2026-09-03.

## Incident and failure model

Dispatch plan 267 contained grouped sales order `GOB-118968-119023`. Active PO
allocations linked it to `LOINC-030542` at `TECHO BLOC Vaughan`. The saved order
contained the current `poPickupManifest`, but its route-driving
`pickupLocations` still contained only `12441`, so DAO load 1 could be saved
without the required Techo pickup.

The failing interleaving is:

1. a planner reads order projection revision A;
2. SCM commits a PO or TO relationship and derives projection revision B;
3. the planner immediately saves a board built from A;
4. global group reconciliation restores structural data but overwrites part of
   B, while another derived field from B survives;
5. the internally inconsistent order and route are persisted.

The authoritative source for this feature is the committed local database
inside the fleet-planning transaction. It includes active PO allocations and
active direct/yard dependency records. Browser state, a prior plan snapshot,
and a global group snapshot are not authoritative for these relationship-
derived fields.

## Required behavior

At every dispatch plan snapshot save boundary:

1. Canonical plan-owned structure is reconciled first. Group, split, CO, custom
   order identity, dispatcher-entered stops, and load assignment remain plan-
   owned.
2. Previously derived PO/TO fields and their pickup locations are removed from
   the candidate projection without removing a location that is also a native
   source location.
3. PO allocations and order dependencies are read again from the committed
   database and applied last, in the same transaction that locks and saves the
   plan.
4. Any order whose route-driving projection changed is reconciled against its
   route. Every required pickup must occur on the same load before the first
   affected customer drop. An existing equivalent manual/shared pickup is
   reused; otherwise a system-managed pickup is inserted.
5. A relationship removal removes only an orphaned system-managed pickup.
   Dispatcher-entered pickup stops are never deleted by this reconciliation.
6. If reconciliation changes a load's physical stop sequence, cached route
   estimates and derived stop/load schedule values for that load cannot be
   retained as current.
7. Existing optimistic revision/digest checks, edit leases, disabled fleet
   checks, and executed-prefix/active-driver protections remain effective. An
   automatic refresh must not silently rewrite an executed physical prefix.
8. Reapplying the same authoritative state is idempotent.

## Explicit exclusions

- This does not fetch NetSuite during a save. "Newest" means the newest
  committed local mirror and relationship state visible under the save
  transaction lock.
- It does not regroup, split, retire, or reactivate orders.
- It does not call an external routing provider. A changed route is marked for
  recalculation and may use the application's deterministic fallback until a
  new route estimate is produced.
- It does not rewrite closed/completed order evidence or completed driver work.

## Acceptance oracles

- Replaying the incident with a stale group order and a current
  `LOINC-030542` manifest produces `pickupLocations` containing both `12441`
  and `TECHO BLOC Vaughan`, with a Techo pickup before the GOB drop.
- The persisted order's PO manifest and pickup locations come from one fresh
  projection, never a mixture of stale and current relationship state.
- Removing the final allocation clears Techo from the derived projection and
  removes only the corresponding managed pickup.
- A matching manual pickup is reused and retains all dispatcher metadata.
- Randomized location/link histories converge to the final authoritative set
  and a second reconciliation makes no further change.
- A stale base revision still fails; an executed-prefix conflict still fails.

## Verification plan

- Unit examples for the incident, unlink, manual-stop preservation, route-cache
  invalidation, and idempotence.
- Property tests over arbitrary native/derived pickup sets and stale histories.
- Integration test against real PostgreSQL tables and `saveDispatchPlanSnapshot`
  proving that a stale payload cannot overwrite a newer PO allocation.
- Concurrency/adversarial tests for revision fencing and active driver work.
- Lint, type/static checks, changed-line coverage, mutation checks, secret scan,
  and the relevant existing dispatch/SCM suites.

## Frontend/bootstrap incident amendment — 2026-09-03

The first repair persisted the required Techo pickup, but the read/bootstrap
path reapplied the active CO overlay after the PO projection. That overlay
reduced `pickupLocations` to the CO destination yard while leaving
`poPickupManifest` intact. The response therefore contained seven physical
stops but claimed that the GOB order required only `12441`; browser cleanup
then removed the Techo stop as an orphan and rendered six stops.

Additional required behavior:

1. Reapplying an active CO changes the native/source-yard pickup to the CO
   destination but preserves current PO- and direct-pickup manifest locations.
2. A bootstrap response must never contain a dependency-managed pickup whose
   matching order projection says that pickup is unnecessary.
3. The incident bootstrap must expose both `12441` and `TECHO BLOC Vaughan`,
   retain the Techo stop before the GOB drop, and remain idempotent.
4. DAO's Driver PWA projection must continue to contain the same seven
   physical stops; no completed or in-progress execution evidence may change.
5. The invalidated route estimate must be replaced with a fresh estimate and
   stop timing, rather than remaining indefinitely pending.

## Browser projection and completion-guard amendment — 2026-09-03

The bootstrap response was later proven correct at seven stops, but the browser
still normalized any order with an active CO to only `transitCo.toYard`.
`syncPickupStops` and `cleanupOrphanPickupStops` consequently removed the
authoritative Techo pickup from the rendered DOM. The old indexed forecast then
labelled a six-visit Oakville-to-GOB leg as Oakville-to-Techo, explaining the
user-visible travel card without a corresponding pickup card.

While diagnosing the rendered route, deleting and re-adding the GOB exposed a
second defect. A completed Sep-2 CO pickup carried the child sales-order refs,
while the CO drop remained in progress. The re-plan guard treated that pickup
as terminal customer-delivery completion and rejected the re-add. The delete
had already autosaved, so the exact pre-delete stop identities had to be
restored from an immutable checkpoint.

Additional required behavior:

1. Browser normalization and local CO reconciliation must project active-CO
   pickups as the unique CO destination followed by current PO/direct manifest
   locations. They must not restore the pre-CO source yard as an active pickup.
2. The browser must render the authoritative seven-stop bootstrap without
   deleting or duplicating the Techo pickup, and repeated normalization must be
   idempotent.
3. A completed Driver `pickup` is execution evidence for that pickup, but is
   not terminal completion of the referenced sales order. Only a completed
   terminal drop-off may activate the global "cannot plan again" guard.
4. A completed CO drop remains terminal for the CO itself and must not make its
   source sales order unavailable for the later customer-delivery leg.
5. Recovery after a rejected re-add must reuse the exact pre-delete GOB drop
   and Techo pickup IDs, preserve every unrelated current stop, and invalidate
   the obsolete route estimate.
