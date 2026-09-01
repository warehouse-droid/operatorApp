# Dispatch CO global lifecycle and recovery evidence

## Incident and acceptance target

- A confirmed 2026-07-14 route retained `CO-GOA-3464-3470-6922`, but the 2026-08-13 order-pool view allowed the relationship to be cancelled and changed its destination from `150` to `12441`.
- The fix must treat CO lifecycle and ownership as global across every non-cancelled Dispatch date, hydrate an active CO into every relevant date view, reject cancellation while any route owns it, and serialize cancellation with plan writes.
- Recovery must be fail-closed and limited to the exact production row derived from the immutable confirmed plan. It must not change a Dispatch plan, snapshot, revision, or CO line.
- Executable specification: `test/dispatch-co-global-lifecycle-spec.md`.

## RED evidence

The initial focused executable specification produced 7 tests with 1 pass and 6 expected failures. The failures covered cross-date cancellation, stale-snapshot assignment fallback, active cross-date hydration, cancel/save serialization, explicit browser cancellation, and exact recovery.

## GREEN evidence

The final isolated lifecycle gauntlet (`bash tools/dispatch-co-lifecycle-gauntlet.sh`) completed successfully:

- focused lifecycle/recovery/frontend/property/concurrency suite: **26/26**;
- related Dispatch performance suite: **99/99** across 21 isolated files;
- Dispatch load-assignment integration harness: **23/23**;
- Dispatch link rollback harness: passed;
- randomized active-CO hydration/cancellation property: **300 generated cases** inside its property test;
- changed-line execution probes: **14/14**;
- critical persisted mutation score: **8/8 killed (100%)**, followed by a green source-restoration run;
- targeted syntax, ESLint with zero warnings, and TypeScript checks: passed;
- dependency, scoped secret, and source-state checks: passed.

Coverage for the two new lifecycle modules was 92.88% statements/lines for `dispatch-co-lifecycle.js` and 97.90% for `dispatch-co-recovery.js`. The gate uses exact changed-line probes instead of hiding unrelated legacy repository coverage.

Source identity at the gate:

- Git base: `8e52af166e7210a751ce08618aea6bd1e457bd11`
- scoped source SHA-256: `556408630412d0385d5e91386b28a4c1d6ac52b90ed442b96ea47fa7636a47a4`

## Complete Driver PWA regression

Before deployment, the complete isolated offline release gauntlet passed **320/320**, with 0 failed and 0 missing:

- 280/280 real-browser cases: 144 mobile WebKit, 88 mobile Chromium, and 48 desktop Chromium;
- 40/40 real Node/PostgreSQL idempotency and concurrency cases;
- all eight former organic WebKit schema-v1 failures (`DOS-001`, `005`, `009`, `013`, `017`, `021`, `025`, and `029`) passed without retry, waiver, or expected-failure treatment;
- offline safety mutation score: **8/8 killed (100%)**, source restored;
- organic IndexedDB errors: **0**; deliberately injected IndexedDB/network/quota faults: 100.

Immutable run: `test-artifacts/driver-offline-stress/runs/full-seed-20260812-2026-08-13T144152-488Z/`, source SHA-256 `895284f96a81a8d9a5151913cb365f53d2e30df729e06691a79af836166c09b0`.

## Production dry-run and deployment

The candidate dry-run refused to proceed unless all of these live facts matched:

- local CO row ID `102`, source `GOA-3464-3470-6922`, delivery-order ID `-102`;
- cancelled state `2967 (28) -> 12441 (15)`;
- exactly two CO line rows: IDs `327`, `328`; source line IDs `4438672`, `4438982`;
- confirmed source plan `48`, date `2026-07-14`, revision `326`;
- owner `BC71838`, `Load 2`, with one pick and one drop;
- immutable source-plan destination `150 (26)` and address `150 Clark Blvd, Brampton, ON L6T 4Y8, Canada`.

The guard was deployed first as production image `sha256:f5da1dea389d28f6d680a2335b4855fd1668068b2c3d0adb8107be55e82ae312`. The service health endpoint and Docker health check were green before recovery.

## Exact recovery and live verification

The apply command changed only `local_co_orders.id = 102` and wrote one audit event:

- status: `cancelled -> pending_load`;
- route: `2967 (28) -> 150 (26)`;
- assignment preserved: plan `48`, 2026-07-14, `BC71838`, `Load 2`;
- both original line IDs and source line IDs preserved;
- source plan remained confirmed at revision `326`, schema v2;
- audit count: exactly 1, action `co_recovered_from_confirmed_plan`, source `dispatch-co-recovery`.

A second apply returned `applied: false` and `alreadyRecovered: true`, proving idempotence and producing no second audit.

Today's plan `233` (2026-08-13) then rehydrated the relationship onto `GOA-3464-3470-6922` and its children:

- `transitCo.id = CO-GOA-3464-3470-6922`;
- `fromYard = 2967`, `toYard = 150`;
- active pickup/source yard `150` with original pickup yard `2967` retained.

The deployed cancellation service was exercised inside an outer rollback transaction. It returned HTTP-equivalent status 409 with code `DISPATCH_CO_ALREADY_PLANNED` and identified plan `48`, 2026-07-14, truck `BC71838`, and `Load 2`. The recovered row remained `pending_load`, `2967 -> 150`, with the same update timestamp.

## Cleanup

The disposable `mbbs-co-global-red` database/container/network, both gauntlet projects, and the five generated test images were removed. Production app, database, and Ollama services remained healthy.

## 2026-08-30 Driver-completed grouped-CO incident

Production plan `263` carried `CO-SOA07510` and `CO-SOA07512` as one grouped transfer from yard `2967` to yard `12441`. Driver PWA record `2347` completed that drop at 2026-08-30 21:47 UTC. The final customer address for `SOA07512` is different, so the source SO correctly remains eligible for a later customer-delivery route from `12441`.

The inconsistency was in the transfer lifecycle: the general Driver completion ledger deliberately supports billable `SO`, `TO`, `PO`, `VRMA`, and `CUSTOM` kinds, but not local `CO`/`CO_ORDER`. Driver evidence therefore blocked re-execution while `local_co_orders` and its canonical mirror never advanced. `CO-SOA07510` also had an earlier cancellation, followed by later physical delivery, which left contradictory audit and operational states.

Before implementation, the isolated schema-190 regression produced the expected RED failures: a normal `pending_load` CO and an earlier-cancelled CO both remained unchanged after a terminal Driver drop. Pickup-only and incomplete-drop controls stayed green.

Migration 191 adds a dedicated, non-billable projection from terminal CO drop evidence to `completed`, plus an idempotent historical backfill. Repository guards keep completed/received COs out of Dispatch and prevent stale saves, cancellation, or upsert from reopening them. Receiving accepts `completed` as the transport-arrived state and moves it to `received` only after normal yard confirmation.

Pre-deployment verification completed with the focused regression at 4/4, migration 101-to-191 upgrade/idempotency replay green, readiness contracts at 16/16, strict lint and TypeScript green, and a mutation score of 17/17 killed (100%) followed by a green source-restoration run. The fresh one-command gauntlet also passed 83 surrounding Dispatch files, 23 load-assignment checks, the link rollback harness, and 22/22 changed-line execution probes; its scoped secret and source-state boundaries were green.
