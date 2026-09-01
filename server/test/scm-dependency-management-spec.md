# SCM Dependency Manager — Executable Specification

Approval: the user approved the decision-complete plan in the preceding turn and explicitly requested implementation.

Tier: 3 — relationship quantities, Dispatch snapshots, Operator materialization, and offline Driver routes can be corrupted by a partial or concurrent write.

## Failure model

| Failure | Required detector |
| --- | --- |
| A TO is linked twice to the same target and the second request is rejected or double-counted | Repository integration and idempotency tests |
| Two different TOs cannot serve the same logical SO/group/split | Repository integration and property tests |
| A TO is moved from one target to another | Integration test expecting `TO_ALREADY_LINKED_ELSEWHERE` |
| The relationship commits but the plan/snapshot update fails | Injected-failure transaction test proving rollback |
| A stale group/split or plan revision receives a relationship | Signature/revision concurrency tests |
| PO unlink bypasses Operator, receiving, or Driver progress | Shared-blocker integration tests |
| An online/offline race lets a Driver use a superseded route | Started-job blocking, manifest fencing, and concurrency tests |
| A screen-off PWA retains an unstarted stale route | Atomic manifest/grant supersession and rejected-event review evidence |
| Route pickup reconciliation deletes a stop another order needs | Shared-pickup property and historical replay tests |
| The new search scans every saved snapshot or loses global targets | Query-count/performance and normal/group/split search tests |
| Existing failed-save recovery or snapshot restore changes behavior | Dispatch recovery/restore regression tests |

## Acceptance scenarios

1. **Create first TO link.** Linking a valid TO delta to an unlinked logical target creates one active dependency with the submitted lines and mode.
2. **Extend the same TO.** Linking the same TO to the same target adds only the submitted delta to the existing dependency and returns `effectiveAction=extend_to`.
3. **Idempotent retry.** Repeating the same committed request ID returns the original result without adding quantity.
4. **Multiple TOs per target.** Two or more distinct TOs may link to one normal, grouped, or split target when aggregate target and TO quantities allow it.
5. **No cross-target move.** A TO linked to a different logical target fails with HTTP 409/code `TO_ALREADY_LINKED_ELSEWHERE`; neither target changes.
6. **Mode is explicit.** Extending an existing TO with a different mode fails with `DEPENDENCY_MODE_MISMATCH`; mode changes use the mode command and the shared blocker.
7. **Exact group/split lines.** Group child and split line keys remain stable; stale target signatures fail with `DISPATCH_TARGET_CHANGED`.
8. **Shared blocker.** TO link/extend/unlink/mode and PO link/unlink all reject closed orders, stale plans, active foreign edit leases, Operator work, receiving work, Driver work, or unresolved offline evidence using stable blocker codes.
9. **Atomic planned change.** A planned relationship change and its refreshed plan snapshot/materialization commit together under locks; injected failure leaves both before-images unchanged.
10. **Pickup conservation.** Added relationships create required pickups before the drop; removed relationships remove only orphaned derived pickups and preserve manual/shared stops and unrelated sequence.
11. **Global latest search.** Server-paged search returns current normal targets, active groups, active split children, and valid remaining source quantities across plan dates without starting NetSuite whole-order sync.
12. **Dispatch parity.** Existing Dispatch link endpoints use the same command and blocker; pending planner edits flush first and no second autosave performs the relationship write.
13. **Unstarted route changes.** A dependency change may update a confirmed route without a Driver PWA readiness handshake when none of the affected order references has actually started Driver work.
14. **Started work is immutable.** Any started or completed Driver job for an affected order is a hard blocker; a readiness acknowledgement can never override it. Planned job rows with no start/completion evidence do not block.
15. **Unrelated activity isolation.** Driver activity for another order or route does not block the selected dependency change.
16. **Manifest fence.** Every successful confirmed-route commit supersedes old manifests/grants atomically. An unexpected old event is retained for offline review and is never applied to the revised route.
17. **Snapshot compatibility.** Old snapshots remain readable; restore uses current relationship ledgers and retains the existing recovery snapshot on validation failure.
18. **No deployment.** Implementation and verification use disposable isolated containers only; production containers, data, and schema are not mutated.

## 2026-08-27 quantity-routing amendment

The user approved partial SO coverage by multiple Transfer Orders and clarified
that direct pickup changes the SO route while yard replenishment does not. This
amendment replaces the old reduced-TO behavior that put a dependency into
attention solely because its TO quantity was below the linked allocation.

19. **Partial TO contributions.** One or more TOs may each contribute less than
    the SO's full item quantity. Each dependency is bounded by its own current TO
    material quantity; the unallocated remainder stays at the SO's normal
    outbound yard.
20. **Reduced direct pickup.** If a direct-pick TO currently carries less than
    its saved allocation, planning remains allowed. Its manifest and pickup stop
    use only the bounded TO contribution, and the difference returns to the SO's
    normal-yard residual.
21. **Reduced yard replenishment.** If a replenishment TO currently carries less
    than its saved allocation, it remains a timing prerequisite without adding
    its source yard to the SO delivery route. Reduced quantity alone does not put
    the dependency into attention.
22. **Mixed-mode conservation.** With direct-pick and replenishment dependencies
    on the same SO, only direct-pick locations affect the SO route. For each item,
    normal-yard residual plus direct-pick contributions equals the SO quantity;
    no contribution is negative or exceeds its TO quantity.
23. **Real blockers survive.** Closed/inactive TOs, missing line identity,
    execution progress, and dependency timing violations retain their existing
    blocking behavior. Ancillary PALLET variance remains non-blocking.
24. **Current-shape replay.** An anonymized fixture covering every current
    SO-to-TO dependency shape is replayed through the quantity and route
    projection, with deterministic results and no false reduced-quantity
    attention.
25. **Extreme mixed-source replay.** One SO may have four concurrent TO
    dependencies plus one PO allocation. Direct TO and PO quantities add their
    pickup locations, replenishment TOs remain prerequisites at the base yard,
    and the base residual conserves the SO quantity after both direct sources.
26. **Zero-contribution direct source.** If a direct TO still exists but its
    current material contribution is zero, its source yard does not create a
    pickup stop. Restoring a positive current quantity restores exactly one
    pickup at that source without duplicating any other stop.
27. **Ten-line ownership split.** For one ten-line SO, three distinct lines may
    be direct pickups through TO0001, three different lines may wait for yard
    replenishment through TO0002, and the remaining four lines may be direct PO
    pickups. Every line has exactly one linked owner, all ten lines remain on the
    customer drop, only TO0001 and the PO vendor add SO pickup locations, and no
    line or pickup is duplicated or empty.
28. **Seeded CO overlays.** Extreme replays apply deterministic seeded CO
    overlays to a subset of direct and replenishment TOs. An active direct CO
    changes only that direct pickup location, cancelling it restores the TO's
    canonical source, and CO destinations on replenishment TOs never leak into
    the SO customer route.

### Amendment failure model

| Failure | Required detector |
| --- | --- |
| A partial TO is compared with the full SO quantity | 10/20/50 multi-TO regression |
| A reduced direct TO removes quantity from both its pickup and the base yard | Per-item conservation assertions |
| A replenishment source yard leaks into the SO route | Mixed-mode route assertion |
| Two direct TOs overdraw one SO line or one TO line | Boundary and property tests |
| Four TOs plus one PO double-count linked cargo | Extreme mixed-source conservation replay |
| A zero-quantity direct TO creates an empty route leg | Physical-visit replay after zeroing and restoring the TO |
| A ten-line SO loses or duplicates lines across TO/PO modes | 3 direct TO + 3 replenishment TO + 4 direct PO line-ownership replay |
| CO overlay randomness makes replay flaky or changes replenishment routing | Seeded CO matrix with active/cancel restore assertions |
| A closed/inactive or started TO becomes silently plannable | Existing blocker and execution regression suites |
| A live dependency shape behaves differently from the deterministic model | Sanitized all-shape replay fixture |

## Interfaces

- SCM page: `/scm/dependency-management` (Admin/SCM/SCM Staff write; Dispatcher read-only).
- SCM APIs: paged order search/detail, preview, commit, pending request create/cancel.
- Driver APIs: authenticated visible presence, pending route request list/readiness/install acknowledgement, and push subscription management.
- Mutation input: UUID request ID, action, target ref/signature, action payload, and expected plan ID/revision/digest.
- Mutation output: allowed/blockers, before/after relationship, affected plan revision, route impact, and idempotent/effective-action flags.

## Setup and constraints

- Use the existing Node test runner, PostgreSQL rollback fixtures, Playwright, c8, ESLint, TypeScript, fast-check, and manual mutation harness pattern.
- Add exactly one runtime dependency: pinned `web-push@3.6.7`, justified because standards-compliant Web Push payload encryption/VAPID signing is security-sensitive and should not be handwritten.
- Store the VAPID private key only in environment secrets; never return/log it. Push payloads contain no order/customer data.
- Preserve all dirty-worktree changes and do not create commits unless separately requested.
- Persist a gauntlet entry point, mutation runner, source-state script, and final evidence report.
