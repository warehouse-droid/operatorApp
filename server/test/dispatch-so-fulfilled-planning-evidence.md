# NetSuite-fulfilled SO Delivery planning — evidence

## Result and scope

Implemented in the workspace. A fully fulfilled NetSuite Delivery SO can display **Completed · delivery pending** and be planned. Completed Driver dropoffs take precedence and prevent a new assignment. Manual completion, Hold/Cancelled, missing or ambiguous identity, blocking reconciliation and active reload work do not receive the new allowance. PO behavior is retained.

No live order cleanup or deployment was performed. The production rehearsal used a temporary process with PostgreSQL sessions forced to read-only and a repeatable-read transaction rolled back at the end. The earlier [cleanup dry run](so-delivery-cleanup-dry-run-20260915.md) remains unapplied.

Spec: [dispatch-so-fulfilled-planning-spec.md](dispatch-so-fulfilled-planning-spec.md). The user confirmed the behavior; **separate written spec approval was not obtained (autonomous run)**. These tests provide evidence for the specified cases, rather than an independent review of the specification.

## What changed

- One authoritative SO policy distinguishes NetSuite fulfillment from physical local delivery. It reads current local NetSuite source records; it does not contact NetSuite per order.
- Explicit search and targeted hydration include eligible billed/inactive Delivery SOs. The unsearched pool retains its existing bounded browse behavior.
- Plan saves, reads and billed reconciliation preserve eligible pending deliveries, including exact active split children. Removed members cannot remove an eligible sibling through its parent reference.
- Legacy and v2 admission checks retain Driver completion protection. Snapshot saves recheck after acquiring the same fleet lock used by Driver completion.
- Catalog reads refresh permission after a Driver completion. Ordinary unaffected snapshots retain their original fields.
- The UI retains completion evidence and shows delivery pending. A locally completed order is search-only and cannot be dragged onto a plan.

## Verification

Final machine-readable results: [summary.json](../test-artifacts/dispatch-so-fulfilled-planning/summary.json).

| Layer | Result |
| --- | --- |
| Focused regressions, properties and concurrency | 44/44 passed |
| Chromium with real Dispatch API responses | 1/1 passed; no page errors |
| Complete Dispatch suite | 576 tests: 566 passed, 10 pre-existing failures; baseline 555 tests: 545 passed, the same 10 failures |
| Broader application suite | 2,375 tests: 2,372 passed, 2 pre-existing failures, 1 pre-existing skip; identical baseline result |
| Changed executable lines | 175/175 executed; new modules: 100% statements/functions/lines, 98.94% branches |
| Mutation | 5/5 deliberate bugs caught by focused tests; 5/5 caught by the property suite alone |
| Types and lint | 233 type diagnostics and 107 lint diagnostics, identical to baseline; zero new diagnostics. New policy/repository lint clean, complexity at most 12 |
| Secrets and dependencies | Changed-line secret scan passed; no dependencies added or changed |

The race test holds the Driver transaction's fleet lock, starts a save, observes the save waiting in PostgreSQL, then commits the delivery. The save rejects with `DISPATCH_ORDER_DRIVER_COMPLETED`; the active snapshot stays empty and exactly one completion event remains.

The HTTP test verifies search → save → confirm → pending Driver job. A second test completes the delivery after search and submits the stale card through legacy save, confirmation and v2 replacement. Confirm rejects with 409. Existing save/replacement recovery behavior returns 202 with `applied: false` and the exact Driver-completed validation issue; the active plan stays unchanged.

## Production read-only rehearsal

Final input/output: [live-read.json](../test-artifacts/dispatch-so-fulfilled-planning/live-read.json), 14 real references.

| Examples | Observed result |
| --- | --- |
| SOR00030, SOB119972, SOA03472, SOB116919-S1 | Completed and planable; physical delivery remains pending |
| SOV02345, SOA07771, SOA07539-S1 | Local Driver completion blocks replanning |
| SOM05681 | Local completion/reload remains blocked |
| SOR00107, SOA05680-S2, SOM05565 | Existing cancellation, split or identity restrictions remain blocked |
| SOA05460-S1, SOA08404-S2 | Remain hidden because their global split definitions are retired |
| SOA08614 | Ordinary planning behavior retained; its stored NetSuite status is still pending fulfillment |

The new rule consumes the application's **synced NetSuite status**. The earlier direct NetSuite dry run identified stale local statuses, including SOA08614. Those discrepancies still require the separate sync/cleanup; this rule does not silently update production status or quantity data.

Screenshots: [fulfilled and planable](../test-artifacts/dispatch-so-fulfilled-planning/fulfilled-planable.png), [Driver completed and blocked](../test-artifacts/dispatch-so-fulfilled-planning/driver-completed.png).

## Spec-to-test mapping

| Spec | Executable evidence |
| --- | --- |
| 1, 2: fulfilled display, planning and persistence | `dispatch-fulfilled-so-planning.test.js` F/G search, save/read/reconciliation, group tests; HTTP confirmed plan and pending Driver job |
| 3: Driver completion takes precedence | Pickup/dropoff comparison, catalog refresh, stale HTTP commands, transaction admission and concurrency tests |
| 4: pickup and ordinary unfinished orders | Pickup/dropoff test; B/E/Pick-Up controls; ordinary local split regression; unchanged SOV repair suite |
| 5: restrictions and PO scope | Hold, Cancelled, missing, review, duplicate, reload and manual completion integration controls; existing PO completed-planning tests |
| 6: lineage and groups | Active/cancelled split tests, sibling Driver isolation, every-member property, grouped billed cleanup and saved group tests |
| 7: discovery bounds | Inactive billed target hydration, default pool exclusion, complete existing Dispatch recency/search suite |
| 8: preserve evidence and cargo | Full source-row/event comparisons on reads; immutable field/idempotence properties; grouped cargo checks; SOV repair regression; race completion count |
| 9: browser behavior | Production render-function tests and Chromium rendering real API responses before and after local delivery |

## Failures found and corrected

Initial behavior tests failed for F/G eligibility, billed-plan preservation, local delivery presentation and split inheritance. Additional checks exposed inactive historical v2 admission, stale catalog eligibility and a missing transaction-level admission recheck. The full Dispatch suite caught extra metadata on ordinary SO snapshots; the fix preserves unaffected snapshots, and the existing SOV repair tests pass unchanged.

Test-harness corrections: the save API uses an existing unapplied recovery-draft contract; assertions now verify that exact contract and unchanged active snapshots. The first browser fixture lacked UTF-8 metadata. The mutation runner initially did not recognize fast-check's wrapped counterexample format; it now records those assertion failures correctly. No behavioral assertion was relaxed to permit delivered orders.

Pre-existing failures remain outside this task. Full names and logs are retained in the machine-readable summary and baseline logs. No new skips were added. Migration rollback testing and dependency audit/license checks were inapplicable because this change adds no migrations or dependencies. Coverage is reported on changed executable lines; branch coverage is 98.94% for the new modules. The unexercised branch is the optional null-order check in the policy helper. The repository type check passes no new diagnostics; unannotated JavaScript does not receive full strict type coverage. No claim is made that every production state was exercised.

## Reproduce

From the repository root:

```bash
bash server/tools/dispatch-fulfilled-so-gauntlet.sh
```

The runner uses disposable PostgreSQL databases on internal Docker networks and removes them afterward. It reconstructs the frozen baseline from the persisted task patch if necessary. The final run reused the already measured immutable baseline with `FULFILLED_SO_REUSE_BASELINE=1`; the default reruns both baselines.

Prerequisites already present in this workspace: Docker, `postgres:18-alpine`, `mbbs-retired-confirm-test:20260914`, `mbbs-mbt-p1-test-e2e:latest`, Python 3 and `patch`. Recorded tools: Node 20.20.2, fast-check 4.9.0, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0.

Optional production read-only rehearsal (requires the configured application environment):

```bash
docker compose --env-file docker/env/.env run --rm --no-deps -T \
  -v "$PWD/server/src:/app/src:ro" --entrypoint node app --input-type=module \
  < server/tools/dispatch-fulfilled-so-live-read.mjs
```

Source identity: [source-hashes.json](../test-artifacts/dispatch-so-fulfilled-planning/source-hashes.json). Git HEAD is `c82c71d6632ffef21ff0a77c3dabbce542f805e2`; the workspace already contained other changes, so the frozen source hashes and task-specific patch identify the tested implementation. No commits, resets or overwrites of the user's existing work were performed.
