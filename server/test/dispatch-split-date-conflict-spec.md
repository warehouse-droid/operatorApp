# Independent split dates — 2026-09-16

Tier 3: existing duplicate-assignment guard. Spec approval: not obtained (autonomous run).

The user's failed snapshots 17496 and 17497 for plan 329 / 2026-09-17 contain
SOA08404-S2 on T4 / BC71838 / Load 1. Validation incorrectly reports it on
2026-09-10 / plan 322. Only SOA08404-S1 is assigned there; its parent alias
SOA08404 must not reserve every sibling split.

Acceptance criteria:

1. A sibling's `split_parent_alias` must not block a different split on another date, including a split nested in a group.
2. An exact assignment of the requested split must still block it, regardless of whether it is directly planned or a group member.
3. An assignment of the whole parent, directly or as a group member, must block its split children. Unknown assignment kinds remain conservative.
4. A planned child must still block planning the whole parent through its exact parent alias.
5. Multiple plans, row ordering, and reference casing must preserve the same result. Only actual conflicting plans are returned.
6. Unassigned records in saved snapshots and definition-creation dates must not create assignments. Existing same-plan/date exclusions remain in force.
7. The actual failed draft must clear this incorrect date conflict with all its orders and stops preserved. Replay must not write production plans, source quantities, driver history, or recovery snapshots.
8. Save endpoints, returned conflict structure, transaction locks, revision checks, and genuine cross-date duplicate protection retain their existing contract.

Failure model: accepting duplicate work (exact/parent/group negative tests and mutations),
rejecting independent work (real failed-draft replay and properties), accidental persistence
(read-only production replay and isolated HTTP saves), race regression (existing concurrent
save suite), and unrelated deployment changes (runtime file hashes and narrow image overlay).

Setup: use existing Node test, fast-check, c8, ESLint, TypeScript and Docker images;
add no dependencies. Isolated ephemeral test database on an internal network, with external
integrations disabled. Preserve unrelated workspace changes; create no commits. Add focused
tests, replay/gauntlet scripts and an evidence report. Deploy only the tested server correction
over the current app image; retain a rollback image and the existing worker configuration.

2026-09-16 API clarification: existing save endpoints return HTTP 202 with
`DISPATCH_PLAN_RECOVERY_SAVED`, `applied=false`, and the nested validation issue
when they retain an invalid draft. Initial negative HTTP assertions expected 409;
correct them to require this exact existing recovery contract, unchanged active
revision, and `DISPATCH_ORDER_ALREADY_PLANNED` inside validation issues. This
does not change the implementation or relax duplicate rejection.
