# Dispatch Planner Performance, Freshness, and Safety — Executable Specification

Status: append-only implementation specification
Assurance tier: Tier 3 (saved-plan data loss, concurrency, public APIs)
Spec approval: not separately obtained; the user authorized autonomous implementation and required tests before code.

## Failure model

| Failure mode | Required detector |
|---|---|
| A failed or malformed snapshot is treated as an empty plan and later overwrites a valid plan. | Frontend state-machine unit tests, browser failure-injection test, backend base-digest contract test. |
| A fresh CO/SO/PO response is overwritten by stale in-memory fields. | Frontend merge tests and targeted-order HTTP integration test. |
| A retry applies group, split, remove, or replan twice. | Command idempotency integration and property tests. |
| A stale dispatcher overwrites a newer revision. | Concurrent-command integration test and durable-state assertion. |
| Rules freeze unrelated drivers or future unstarted stops. | Shared activity-policy unit/contract tests and historical-plan continuous-action test. |
| Executed driver evidence is silently changed. | Active-prefix adversarial tests and backend rejection tests. |
| Historical-plan edits are rejected because the same order belongs to that same plan or a later snapshot-derived structure. | Previous-date remove/re-add and group/ungroup/replan integration scenarios. |
| Snapshot listing or saving scales with every full unassigned order or every archived JSON document. | Payload-size assertions, SQL/response contract tests, and timed 609/2,000-order benchmarks. |
| Cross-module follow-up work makes the core save wait or partially commits without visibility. | Outbox transaction/retry integration tests and timing-stage assertions. |
| Opening or completing a popup rebuilds the entire planner and loses focus/state. | Frontend render-boundary unit test and Playwright popup/continuous-action test. |
| Retention deletes an active plan, driver evidence, or audit data. | Retention integration and adversarial boundary tests. |

## Executable scenarios

### DP-01 — Snapshot failure fails closed

Given a valid board at revision 17, when a refresh times out, returns HTTP 500, or returns malformed snapshot data, then the valid board remains visible, planner state becomes `stale` or `failed`, and every mutation/save/confirm capability is false. No save request may be produced until a valid snapshot is loaded.

### DP-02 — Explicit missing plan is distinct from failure

Given the server returns an explicit `exists: false` result for a date, then the client may show a new blank plan workflow. A transport error or an ambiguous empty response must never be interpreted as `exists: false`.

### DP-03 — Fresh operational data wins

Given an existing order with stale address, quantities, status, and items plus local placement/timing UI fields, when a newer version of that order arrives, then server operational fields replace the stale values while the allowlisted local planning fields remain. Executed evidence is not overwritten and is displayed as a separate evidence snapshot.

### DP-04 — Compact plan excludes the unassigned pool

Given 609 canonical orders with 12 assigned orders, one unassigned group, one split family, one CO, and one custom order, when a plan snapshot is built, then it contains all assigned and plan-owned derived records but none of the other unassigned canonical orders. Its serialized size is below 250 KB.

### DP-05 — Continuous remove, group, ungroup, and replan

Given a draft plan with orders A, B, C, and D, when a dispatcher removes A, groups B and C, ungroups that group, and replans A into the same load, then each command advances the revision exactly once, no order or stop is duplicated, A is assigned once, and B/C return as independent orders.

### DP-06 — Exact retry is idempotent

Given any successful command from DP-05, when the same `commandId` and body are submitted again, then the original stored result is returned with no revision increase and no repeated side effects. Reusing the `commandId` with a different body returns `409 DISPATCH_COMMAND_ID_REUSED`.

### DP-07 — Previous-date remove and re-add is allowed

Given a historical draft plan whose order A is assigned only to that same plan, when A is removed and then re-added to that plan date, then both operations succeed. Planning A on a genuinely different active date remains blocked with `DISPATCH_ORDER_ALREADY_PLANNED`.

### DP-08 — Historical grouping does not inherit a later structure

Given a normal order on an older plan and a group/split derived from it in a later plan, when the older plan is loaded, removed, grouped, ungrouped, and replanned, then the later structure does not replace or hide the older plan's order identity.

### DP-09 — Executed prefix only is protected

Given activity on physical stop 2 of a load, then changing the load's driver/truck, stop 1, stop 2, their allocations, or their sequence is rejected. Appending, correcting, removing, or reordering stops strictly after stop 2 is allowed. Other loads and other drivers remain editable. Synthetic travel/rest/truck-switch activity alone does not freeze the future suffix.

### DP-10 — Concurrent stale command is rejected without mutation

Given two sessions at revision 20, when session A commits revision 21 and session B submits against revision 20, then session B receives `409 STALE_DISPATCH_PLAN`, the revision remains 21, and session A's result remains durable.

### DP-11 — CO update is targeted

Given a 609-order feed, when a dispatcher updates one source order and creates or updates its CO, then the HTTP response contains the affected source order and CO only, the browser does not merge or render all 609 orders, and the plan command stores the CO relationship exactly once.

### DP-12 — Split creation is one atomic command

Given an unsplit order and requested parts, when the split command is submitted, then suffix allocation, split validation, split creation, plan mutation, and audit occur atomically. A retry returns the same split references. Unsplit restores the source order once.

### DP-13 — Snapshot list is metadata-only

Given at least 100 archived checkpoints containing large documents, when the checkpoint list is requested, then its query/response does not include checkpoint order or board documents, the response is below 100 KB, and selecting one checkpoint loads only that document.

### DP-14 — Seven-day checkpoint retention is safe

Given expired and unexpired checkpoints plus an active plan, command audits, and driver evidence, when retention runs, then only archived checkpoint documents older than seven days are removed. Active plans, current snapshots, commands, audits, and driver evidence remain.

### DP-15 — Popup rendering is isolated

Given a large rendered planner, when the CO, group, or split popup opens or receives an input update, then only the popup layer is replaced. The planner root, board scroll, selected load, and unrelated focused input remain unchanged.

### DP-16 — Timed response budgets

Using deterministic isolated fixtures with 609 orders and at least 50 checkpoints:

- compact bootstrap response: under 250 KB and P95 server time below 500 ms;
- metadata-only checkpoint list: under 100 KB and P95 below 500 ms;
- group, ungroup, remove, replan, CO, split, and unsplit command acknowledgement: P95 below 1,000 ms and each single response below 250 KB;
- full continuous sequence from DP-05: below 4,000 ms server-side in the isolated test environment;
- frontend pure merge/command reduction for 2,000 orders: P95 below 50 ms.

Every performance test records individual samples, median, P95, maximum, and response bytes in `test-artifacts/dispatch-performance.json`. Budgets deliberately include generous CI/container headroom and may not be weakened to make tests pass.

## Negative constraints

- Existing Driver PWA, Operator, SCM, MBT, legacy Dispatch APIs, and confirmed-plan behavior must remain compatible.
- No browser Cache Storage entry may contain private Dispatch API data.
- No read endpoint may mutate or clean operational plan state.
- No normal mutation may delete executed driver evidence.
- No full order-pool reload or complete planner-root render may be required after CO/group/ungroup/split/unsplit success.
- No new runtime or test dependency is authorized.
- No production database or production NetSuite/Samsara endpoint may be used by tests.
- Existing snapshot history must not be destructively pruned during migration; retention runs separately in bounded batches after the new code is live.

## Setup and gauntlet plan

- Reuse Node 20, `node:test`, Playwright, c8, TypeScript, ESLint, PostgreSQL, and the existing isolated Docker test environment.
- Add no dependencies and do not modify package-lock dependency resolution.
- Add focused frontend unit/contract tests, backend unit/property/integration/concurrency/adversarial tests, and isolated Playwright coverage.
- Persist a single `npm run gauntlet:dispatch-performance` entry point plus a reproducible manual mutation runner.
- Do not create checkpoint commits because the user did not authorize a commit cadence; identify final source state with the existing Git SHA plus working-tree diff hash in the evidence report.
