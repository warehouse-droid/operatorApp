# Dispatch CO authoritative-route merge specification

Status: autonomous production repair requested on 2026-09-01.

Spec approval: not obtained as a separate checkpoint. The user requested that
the live `SOA07894` stale-CO behavior be diagnosed and fixed. These scenarios
were stated before implementation; confidence therefore comes from the observed
RED failure, the isolated gauntlet, and the production witness.

## Production witness

- The original `CO-GOA-7894-7895` write at 20:14 UTC stored `2967 -> 3445`.
- Later writes at 21:10 and 21:16 UTC correctly stored `2967 -> 12441`.
- At diagnosis time, `local_co_orders`, `dispatch_global_order_groups`, and
  `dispatch_order_catalog_entries` all held `2967 -> 12441`.
- Plan commands from the browser were repeatedly rejected with
  `STALE_DISPATCH_PLAN`; the active plan snapshot did not contain the newly
  accepted CO relationship.
- A targeted catalog refresh merged its authoritative order into an older
  planner order, but `preserveDispatchPlanningFields` gave the old non-null
  `transitCo` precedence. This could keep displaying `3445` after the server had
  accepted `12441`.

## Executable scenarios

1. Given planner memory with `CO-GOA-7894-7895` at `2967 -> 3445`, when a
   targeted authoritative order carries the same CO at `2967 -> 12441`, the
   merged `transitCo.toYard`, `sourceYard`, and `pickupLocations` are `12441`.
2. Given an authoritative active CO for any configured yard pair and lifecycle
   status, the authoritative CO object wins while group identity and children
   remain unchanged.
3. Given a sparse refresh that omits the `transitCo` property, existing
   `transitCo`, `transitOriginalPickupLocations`, and
   `transitOriginalSourceYard` remain intact.
4. Given an authoritative cancellation with `transitCo: null`, the relationship
   and both original-route metadata fields are cleared.

## Invariants and setup

- No database schema or public response shape changes.
- No new dependency is installed; the existing Node test runner, `fast-check`,
  ESLint, TypeScript, and Docker test image are used.
- Group membership and unrelated local placement fields retain their existing
  merge behavior.
- The production CO row is not rewritten by this repair; it is already correct.
- Tests use disposable containers. No commit is created in the user-owned dirty
  worktree.

## Addendum: shared standalone CO snapshot repair

Status: autonomous follow-up requested after the user confirmed the stale card
appears on multiple computers.

5. Given a confirmed plan snapshot whose standalone `CO-GOA-7894-7895` card
   says `2967 -> 3445`, while the active `local_co_orders` row says
   `2967 -> 12441`, every plan/bootstrap read returns the standalone CO as
   `2967 -> 12441`.
6. The repair also replaces the stale destination location ID and own-yard
   address, while preserving CO group children, truck/load placement, stop IDs,
   and unrelated plan evidence.
7. Reconciliation is immutable and idempotent: it does not rewrite archived
   history and a repeated read returns the same result.
8. Cancelling and recreating the already-correct CO is not part of the repair;
   the active CO row is the authority used to repair the shared snapshot.
9. If that local CO is explicitly cancelled, a legacy standalone card whose
   child details make it look like an aggregate group is removed from every
   bootstrap together with any stale load/order/stop references, so it is no
   longer visible or plannable.
10. A synthetic aggregate CO group with no matching local CO row is preserved;
    cancellation cleanup applies only to a persisted local CO row whose status
    is actually `cancelled`.

## Addendum: NetSuite-driven derived-order freshness

Status: explicitly requested by the user on 2026-09-01 after the stale
ungroup/catalog incident. NetSuite changes are simulated against the isolated
mirror tables; the test must not write to a real NetSuite account.

11. Given two source SOs, an active global group, and an active split, when a
    simulated NetSuite sync changes a source yard or status, the raw catalog,
    split definition, group child detail, group aggregate, targeted order feed,
    pool card, and live bootstrap all expose the newest source values.
12. Historical snapshot rows remain byte-for-byte unchanged. Live bootstrap
    overlays current global definitions and local CO state without rewriting
    saved history.
13. Given an active CO when its source yard changes in NetSuite, the CO's own
    persisted route remains authoritative until cancellation, while its source
    order's recoverable base route advances to the newest NetSuite yard.
    Cancelling the CO restores that newest yard, never the pre-sync yard.
14. Reinitializing the cancelled CO with `reactivateCancelled: true` and a new
    destination replaces its route and source details everywhere; no cancelled
    card or previous destination may survive in pool or bootstrap.
15. Unsplit and ungroup retire the global definition, delete any catalog shadow,
    and make targeted lookup return `null`. A delayed catalog refresh must not
    resurrect either retired definition.
16. Repeating CO cancel/reinitialize, split/unsplit, group/ungroup, and source
    refresh in different orderings is idempotent: at most one active canonical
    row exists per ref, members are neither lost nor duplicated, and unrelated
    catalog rows remain unchanged.
17. A source refresh and a structural retirement racing in either serial order
    converge to the retired definition being invisible. Cleanup is atomic and
    safe when called again after the definition is already inactive.
18. An exact isolated replay for `SOA07894`, `SOA07895`,
    `GOA-7894-7895`, and `CO-GOA-7894-7895` records every event boundary.
    Each boundary must agree across mirrored NetSuite rows, refresh-outbox
    completion, canonical group/split/CO rows, catalog entries, targeted and
    pool reads, live bootstrap, and the real browser-rendered order cards.
    Retired/cancelled refs must be absent rather than merely disabled.
19. Given a grouped CO whose members retain source SO/TO references, a NetSuite
    refresh for one source may refresh that source lifecycle but must never
    replace the local CO wrapper, change its type to SO/TO, or create a mixed
    group that makes plan, forecast, monitor, or V2 bootstrap reads return 409.
20. Repeating the source refresh preserves every grouped-CO member identity and
    type, while normal SO/PO/TO groups and splits still consume fresh NetSuite
    fields as before.
21. After an explicit ungroup or unsplit retires a durable global definition,
    an ordinary stale save or force-save containing that old group/split is
    rejected with `DISPATCH_DERIVED_ORDER_RETIRED`; its snapshot transaction
    rolls back and the retired definition stays invisible.
22. Reusing the same group/split reference is permitted only when the accepted
    client action explicitly sends that reference in
    `reactivatedGlobalOrderRefs`. Unrelated edits, undo history, saved plans,
    searches, assignment projections, and delayed pool feeds cannot grant that
    authority implicitly.
23. A standalone CO can contain child-order details, but it is never treated as
    a regrouped SO/TO definition. Cancellation remains authoritative through
    every frontend ingress, while a successfully accepted same-ref CO
    reinitialization clears only that CO tombstone.

### Failure model and setup addendum

- Failure modes: stale catalog shadows, frozen group children, frozen split
  route/status, cancellation restoring an old yard, delayed refresh resurrecting
  retired definitions, partial cleanup, duplicate membership, and test-order
  dependence.
- Existing Node, PostgreSQL, Docker, `fast-check`, ESLint, and TypeScript tools
  are used. No dependency or schema migration is added.
- The test updates only disposable mirrored NetSuite rows and uses transaction
  rollback or an isolated Compose database. Production NetSuite is read-only.
- Public API response shapes, structural assignments, local CO lifecycle guards,
  and archived plan history must remain unchanged.
