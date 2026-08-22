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
| An online/offline race lets a Driver use a superseded route | Driver readiness, manifest fencing, and concurrency tests |
| A screen-off PWA silently receives a route replacement | Pending-request E2E: no mutation before visible authenticated readiness |
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
13. **Visible Driver readiness.** A confirmed route with an issued manifest changes only after every route-bearing device is visible, online, synchronized, idle, and has a current short-lived readiness token.
14. **Screen off waits.** A suspended/offline device creates a pending request only. A visible notification may prompt the driver, but notification delivery never authorizes the change.
15. **Fresh human retry.** When the Driver becomes ready, SCM must re-preview and click Apply; pending requests never auto-apply.
16. **Manifest fence.** Successful commit supersedes old manifests/grants. An unexpected old event is retained for offline review and is never applied to the revised route.
17. **Snapshot compatibility.** Old snapshots remain readable; restore uses current relationship ledgers and retains the existing recovery snapshot on validation failure.
18. **No deployment.** Implementation and verification use disposable isolated containers only; production containers, data, and schema are not mutated.

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
