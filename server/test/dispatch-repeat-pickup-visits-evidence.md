# Repeated pickup visits evidence

Status: implemented and verified; not deployed.

Source baseline: `39cf22656d3dc4c7b536681878867ba137bb0f1b` plus the current reviewed working-tree changes.

## Behavior proved

- Normal unstarted orders still share one automatic pickup visit.
- Adding a late order after its same-yard pickup is complete creates a new pickup stop. The completed pickup and active travel destination remain unchanged.
- Dispatch can split one future grouped pickup into two visits by whole order. A partial line or partial quantity cannot be moved.
- Each pickup visit has its own stable stop ID, scoped `orderRefs`, Driver PWA job, status, and photo evidence.
- Legacy loads remain byte-for-byte compatible until they opt into pickup-visit schema version 1. Ambiguous legacy allocations fail closed instead of being guessed.

## Frontend route output

The real Dispatch page was exercised in desktop Chromium, mobile Chromium, and mobile WebKit, with no browser skips.

The automatic late-order scenario produced this logical route:

`P-A -> P-V -> D-V -> AUTO-PICK -> D-A -> AUTO-DROP`

The frontend rendered these physical cards:

`P-A -> P-V -> D-V -> AUTO-PICK -> D-A`

The final two same-address deliveries are intentionally consolidated into one visible card. The browser asserted these exact labels:

- `1. Pickup 3445 · Visit 1/2 · 1 order`
- `4. Pickup 3445 · Visit 2/2 · 1 order`
- `5-6. SO-A + SO-LATE`

The manual browser workflow began with one five-order pickup, selected `SO-D` and `SO-E`, saved exactly one plan update, and rendered:

- `Pickup 3445 · Visit 1/2 · 3 orders`
- `Pickup 3445 · Visit 2/2 · 2 orders`

The persisted pickup allocations were exactly `[SO-A, SO-B, SO-C]` and `[SO-D, SO-E]`; all five delivery stops remained present. The screenshots scroll the route container to make the later pickup visible:

- [Automatic revisit, desktop Chromium](../test-artifacts/dispatch-repeat-pickup/frontend-automatic-revisit-chromium-desktop.png)
- [Automatic revisit, mobile Chromium](../test-artifacts/dispatch-repeat-pickup/frontend-automatic-revisit-chromium-mobile.png)
- [Automatic revisit, mobile WebKit](../test-artifacts/dispatch-repeat-pickup/frontend-automatic-revisit-webkit-mobile.png)
- [Manual 3+2 split, desktop Chromium](../test-artifacts/dispatch-repeat-pickup/frontend-manual-3-plus-2-chromium-desktop.png)
- [Manual 3+2 split, mobile Chromium](../test-artifacts/dispatch-repeat-pickup/frontend-manual-3-plus-2-chromium-mobile.png)
- [Manual 3+2 split, mobile WebKit](../test-artifacts/dispatch-repeat-pickup/frontend-manual-3-plus-2-webkit-mobile.png)

## Driver PWA route output

The real Driver PWA was exercised in the same three browser/device projects. Its fixtures used production Driver job construction and next-job selection against an isolated database.

- The automatic route initially rendered `Pickup 3445` with only `SO-A`.
- After every preceding job was recorded complete, production next-job selection returned a different job ID for `AUTO-PICK`; Refresh rendered `Pickup 3445` with only `SO-LATE`.
- The manually split route initially rendered the first pickup with exactly `SO-A`, `SO-B`, and `SO-C`. After its preceding route prefix was completed, Refresh rendered the later pickup with exactly `SO-D` and `SO-E`.

Driver screenshots:

- [Automatic first 3445 pickup, desktop Chromium](../test-artifacts/dispatch-repeat-pickup/driver-automatic-visit-1-chromium-desktop.png)
- [Automatic late 3445 pickup, desktop Chromium](../test-artifacts/dispatch-repeat-pickup/driver-automatic-visit-2-chromium-desktop.png)
- [Automatic late 3445 pickup, mobile WebKit](../test-artifacts/dispatch-repeat-pickup/driver-automatic-visit-2-webkit-mobile.png)
- [Manual later 2-order pickup, desktop Chromium](../test-artifacts/dispatch-repeat-pickup/driver-manual-visit-2-chromium-desktop.png)
- [Manual later 2-order pickup, mobile WebKit](../test-artifacts/dispatch-repeat-pickup/driver-manual-visit-2-webkit-mobile.png)

## Automated verification

- Focused unit, property, adversarial, concurrency, frontend, and Driver contracts: 38/38 passed.
- Changed pickup-visit module coverage: 100% statements, 100% functions, 100% lines, and 82.44% branches.
- Critical mutation tests: 11/11 mutants killed.
- Stale unplan/order-pool/browser-generation mutation tests: 4/4 mutants killed.
- Real-browser Dispatch and Driver PWA route tests: 12/12 passed across the three browser/device projects above (6 Dispatch and 6 Driver PWA).
- Complete isolated Node regression: 440/440 files and 2,198 tests passed.
- Exhaustive legacy baseline: 134/134 harnesses passed.
- Planner optimization regression: 80/80 passed.
- Driver PWA legacy harness: 96 scenarios passed.

The first exhaustive run exposed two HTTP tests that implicitly depended on the database's public-Sales setting. With public Sales enabled, the application correctly returned a private-record 403 rather than the tests' assumed unauthenticated 401. Both fixtures now explicitly disable and restore that setting; their focused rerun passed 5/5 and the complete 440-file rerun passed.

## Seven-day chronological replay

Window: the seven complete Toronto-local days from 2026-08-27 through 2026-09-02.

- Source rows captured in a repeatable-read, read-only transaction: 5,822.
- Replay events, including two explicit missing-stream gap events: 5,824.
- Projection comparisons: 5,824, with 0 mismatches.
- Dispatch plan states examined: 546.
- Captured Driver activity rows: 384.
- Historical plan states eligible for injection: 358.
- Eligible load occurrences tested with a fake late order: 2,232.
- New repeat pickups created: 2,232; existing future pickups reused: 0.
- Second customer visits created when the original visit was already sealed: 2,141.
- Driver PWA jobs generated and scope-checked: 9,972, with 0 scope failures.
- Synthetic activity records used to exercise route boundaries: 2,495.
- Legacy pass-through conflicts: 0; legacy route mutations: 0.
- Post-injection validation failures: 0; protected-prefix violations: 0.

Replay artifacts:

- [Sanitized seven-day capture](../test-artifacts/dispatch-planner-replay/seven-day-2026-08-27_2026-09-02-capture.json)
- [Chronological replay report](../test-artifacts/dispatch-planner-replay/seven-day-2026-08-27_2026-09-02-offline-report.json)
- [Repeat-pickup injection report](../test-artifacts/dispatch-planner-replay/seven-day-2026-08-27_2026-09-02-repeat-pickup-report.json)
- [Sanitized Driver corpus](../test-artifacts/dispatch-planner-replay/seven-day-2026-08-27_2026-09-02-driver-corpus.ndjson)

## Driver rollback replay

The sanitized corpus replayed 381 supported jobs across 345 physical visits, including 25 consolidated physical visits:

- 119 pickups, 171 drop-offs, and 91 travel jobs.
- Original statuses: 360 complete, 18 in progress, and 3 pending.
- Every completion retained the required photo evidence, and an exact retry left durable evidence unchanged.
- The entire replay ran inside a forced rollback transaction.
- A separate database query found 0 `seven-day-replay:%` rows afterward.

## Explicit evidence limits

- The capture contains 75 explicit evidence gaps. The source database had no raw `netsuite_mirror_events` or `driver_offline_events` rows for this window; 2,250 NetSuite-derived events and 384 retained Driver job rows were still available.
- The historical window contains no `splitPoDirectShip` or `groupPoLink` event. Those paths remain covered by deterministic tests, but are not claimed as historical observations.
- 208 malformed or ambiguous legacy source states were reported as source-materialization conflicts (`missing order`, `empty pickup`, or `pickup after delivery`). They were excluded from injection and were not counted as passes.
- The dependency audit reports four pre-existing package advisories (three moderate and one high). This change adds no dependency and does not alter those advisories.

## Safety boundary

- No NetSuite, production Dispatch plan, source snapshot, or live Driver record was mutated.
- Replay fake orders existed only in sanitized in-memory clones; browser fixture orders and completion states existed only in the disposable isolated test database and were explicitly cleaned.
- Driver completion writes were rolled back and independently checked for leakage.
- No deployment command was run.
