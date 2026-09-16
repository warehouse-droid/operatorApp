# Transfer Order cleanup — 2026-09-15

## Scope and authorization

The user requested the same one-time cleanup as SO, including Receiving, with a dry run, an isolated container rehearsal, live application and checks of today's operations. They explicitly selected NetSuite Received or confirmed local Receiving as receipt evidence, and asked to skip review records. No further approval was required. The executable spec was prepared autonomously; separate spec approval was not obtained.

- [Acceptance rules](to-cleanup-spec.md)
- [Skipped transfer orders and reasons](to-cleanup-skipped-20260915.csv)

NetSuite fulfillment makes an eligible TO Loaded in Operator and Complete but planable in Dispatch. Driver/manual/direct completion makes it Loaded and blocks replanning. The local delivery path preserves cached NetSuite status and fulfillment fields. Receiving requires separate receipt proof; Pending Receipt alone does not qualify.

## Reviewed manifest

Manifest SHA-256: `c0c91e2453c7efdb86765dc9feea9d7f5b8294e2bc9f5aab4f9c9d20f2b34922`.

| Result | TOs |
| --- | ---: |
| Qualify for Loaded and Received | 826 |
| NetSuite-only completion; planning allowed | 676 |
| Local delivery; replanning blocked | 150 |
| Skipped for review | 33 |
| Outside the cleanup criteria | 63 |

The 33 skipped records comprise 25 Receiving synchronization exceptions, six records in cancelled source families, one duplicate local reference and one unsafe packed line. TO-linked `CO-TOB00762` was already Loaded; no CO mutation was required.

The final current-data dry run proposes 766 header updates, 2,302 outbound-line updates, 2,744 Receiving-line updates and eight NetSuite observation completion events. Of the header changes, 243 move Receiving to Received; the other qualifying Receiving headers were already Received. Observation events record when NetSuite fulfillment was observed, with the physical delivery time explicitly unknown. A final freshness check preserved seven TOs already loaded by Operators during testing, reducing outbound updates by 14 lines. Every successful local Receiving record is covered by either the qualifying set or the explicit review exclusions.

## Validation

- A real Dispatch admission test fails on the deployed baseline for a NetSuite Received TO, establishing the behavior being fixed.
- 52 focused tests across 10 files pass, including SO/PO/CO regressions, exact status and identity rules, split/group authority, both line stages, quantity preservation, stale-manifest rejection and repeat application.
- HTTP tests exercise cleanup, plan save, confirmation, Driver pickup/drop completion and subsequent replanning rejection. Forged client eligibility flags cannot bypass restrictions.
- Two real-browser checks pass: eligible completed SO/TO cards can be dragged; Driver-completed cards are search-only.
- The final captured-data rehearsal copies all 922 TO headers and 6,649 lines into an isolated PostgreSQL container. It reproduces the manifest exactly, rolls back cleanly, applies the expected 826 changes, preserves skipped records and yields zero changes on repeat. All 150 local deliveries remain blocked; all 676 NetSuite-only TOs are eligible for planning.
- All 128 changed executable runtime lines are covered. The two new runtime modules and two cleanup modules have 100% statement, line and function coverage, with 95.4% combined branch coverage.
- Five targeted mutants are killed by the complete unit suite and independently by property tests: 10 successful mutation checks.
- Syntax checks pass for 12 files. There are no new lint or type findings relative to the baseline; 104 existing lint findings and 233 existing type diagnostics remain.

The full comparison ran against the final deployed baseline and the combined TO release. The 475-file MBT suite has the same two pre-existing failing tests (`p3-gauntlet-contract` and `production-runtime-contract`). The 134-file Dispatch suite has the same ten pre-existing failing tests across six files. Neither suite has a new failure. Exact failing test names and matching source hashes are in `server/test-artifacts/to-cleanup-20260915/evidence.json`; full logs are retained beside it.

## Deployment and preservation

The release contains exactly seven TO runtime files, layered on `mbbs-operator-app:blanket-auto-resume-20260915-v1`. Two concurrent releases were detected during preparation; their changes were preserved and the final combined source was retested. The tested image is `mbbs-operator-app:to-cleanup-20260915-v1`.

Before application, the tool obtains Fleet/Operator locks and table locks, rechecks exact before-images and evidence, and updates atomically. Afterward it asserts that Driver jobs/photos, receipt records, posting commands, dependencies, COs, Dispatch plan snapshots, schedules and reconciliation rows are unchanged. It performs no NetSuite writes and creates no physical receipt or Driver evidence.

Backups and source hashes are under `docker/backups/to-cleanup-20260915/`. The table dump is `pre-to-cleanup.dump` (SHA-256 `903111a106ab742bcb0bf47e0e927fbd37fb1f5d815d58c3d3f37448c586f616`); the newer exact before-images are in `production/before.json` and the reviewed manifest. The CLI `rollback` mode is a transaction rehearsal, not an inverse cleanup command.

## Live result

Applied successfully at **2026-09-15 18:33:56 UTC**. The actual changes match the refreshed dry run exactly: 826 TOs, 766 headers, 2,302 outbound lines, 2,744 Receiving lines and eight observation events. All protected-state assertions passed inside the transaction.

Live verification at **18:36:26 UTC** confirms:

- All 826 qualifying TOs are Loaded and Received. Of these, 243 Receiving headers changed to Received.
- All 676 NetSuite-only completions are eligible for planning; all 150 local deliveries are blocked from replanning. No additional planning restrictions appeared in the eligible set.
- Corrected orders are absent from active Operator Delivery and pending Receiving feeds. The repeated cleanup proposes zero changes.
- The 33 review exclusions and 63 nonqualifying TOs were not changed by the cleanup. `CO-TOB00762` remains Loaded.
- Today's Toronto plan 327 remains confirmed, with the same 18 loads. All five Driver routes (63 jobs), 24 SO Operator details and three TO details read successfully, without Operator warnings in the inspected orders.
- `TOB01070` remains Packed / Not Received, with pending Driver pickup/drop work and no Dispatch restriction. It has not yet met the cleanup completion criteria. `TOB01086` and `TOB01090` are Loaded and locally complete, so replanning is correctly blocked. `TOB01090` also shows Received in Receiving.

No cleanup-related blocker was found in today's Driver, Operator/Receiving or Dispatch checks. Live checks were read-only; operational completion and replanning writes were tested in isolated containers. See `production/live-evidence.json`, `production/runtime-verification.json`, `production/today-all-read.json` and `production/apply-result.json` under the artifact directory for the exact results.
