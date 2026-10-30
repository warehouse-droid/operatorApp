# Linked BIN delivery planning — 2026-10-23

Spec approval: not obtained (autonomous run). The user explicitly requires the
linked delivery to be planned automatically with its collection. Tier 3 for
shared-bin reservations and concurrent planning. No new dependencies or commits.

1. Dragging/planning a collection with a linked receiving delivery adds both to
   one load, in collection → dump → receiving cargo stops → delivery order.
   Both use the same physical bin; the receiving leg has no extra yard pickup.
2. A linked delivery is not independently assignable while its collection is
   unfinished. Moving or unplanning either member keeps the unfinished pair
   together. Completed collections permit their remaining delivery to proceed.
3. The bin source is shown as the selected dump site, separately from any cargo
   pickup. Search/pagination must not prevent the linked delivery being included.
4. Keep requested customer windows, cargo stops, evidence requirements, billing
   ownership, unrelated loads and normal unlinked planning unchanged.
5. Assignment, claims and both route members commit atomically. Missing cargo,
   stale revisions, invalid ordering, split loads and concurrent commands cannot
   leave a partial or duplicate route. Existing leases and authorization apply.

Failure model: missing stops → real browser + persisted route assertions;
incorrect custody → exact asset/source assertions and existing driver suites;
partial writes/races → rollback/concurrency/idempotency tests; stale client or
forged split route → authoritative board validation; hidden linked card → filtered
feed/browser test. Use the bounded disposable runner, static checks, properties,
manual mutants and changed-source coverage. Deploy a narrow live-source overlay.

Live observation: the user subsequently placed both BIN00002X-1C and BIN00004D
on plan 365 / October 21. Their saved sequence already contains collection,
dump at 3445, Gravel pickup at 150, delivery. Preserve this existing route.

Clarification during implementation: route optimization must also preserve the
collection/dump before the linked receiving delivery, even when customer windows
sort the receiving order first. The requested windows remain unchanged.

Regression setup: same-bin planner tests now assert the automatic receiving leg
instead of manually assigning it again. The existing overnight-custody scenario
uses the single-visit fixture primitive to recreate an older saved route; its
confirmation, physical source and delivery-reference assertions remain intact.
Unplanning and immediately replanning before autosave must also retain both legs,
and a cancelled receiving order must block the paired drop without partial stops.
