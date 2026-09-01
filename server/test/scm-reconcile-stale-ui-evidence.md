# Evidence — reconciliation automation and stale planning UI

Status: GREEN, deployed, and production-repaired on 2026-08-29.

The executable specification was recorded autonomously from the operator's
request rather than separately pre-approved. That lowers confidence in the
wording of the specification, but not in the executable results below.

## RED reproduction

The defects were reproduced before their production implementations changed:

- Dispatch Planning treated any stale `dispatchPlanned` catalog metadata as a
  foreign-plan assignment after the order had been removed locally. A
  same-plan order therefore stayed locked, jumped back to its old placement,
  and could not be dragged without repeated refreshes.
- PO Split optimistically applied a successful status/remark save and then
  immediately reloaded an older catalog snapshot. The older row replaced the
  successful response, so Hold appeared to revert to Queued even though the
  database write had committed.
- A destination override changed the physical destination while the browser's
  retained NetSuite baseline stayed stale.
- A reconciliation-created Queued schedule row was interpreted as operational
  planning evidence. Exact safe TO quantity decreases were consequently sent
  to Reconcile Review, and the Dispatch guard compared every plan order rather
  than only newly placed/moved assignments.

Focused RED tests observed the wrong lock result, the unnecessary full reload,
the reverted Hold/remark values, the stale destination baseline, the false TO
review, and the unrelated-board-save block before the fixes were applied.

## Implemented behavior

- Dispatch now treats the current plan ID as authoritative. Legacy assignment
  metadata without a plan ID is accepted only for the current plan date;
  genuinely foreign-plan assignments remain locked. The existing plan-save
  transaction already updates the assignment projection synchronously, and a
  regression now protects that invariant.
- PO Split consumes the authoritative row returned by status and remark writes
  instead of replacing it with an immediate broad reload. Destination writes
  merge the returned orders and NetSuite location into browser state.
- PO Split's mini grid now has separate routing and notes/action rows with a
  responsive layout. PO Split and PO/TO Schedule label the baseline destination
  as `<location> (NetSuite)`.
- A Queued row without a Dispatch plan ID or ETA is not operational planning
  evidence. Exact quantity decreases are accepted when progress, split
  capacity, pinned targets, locations, and line identity remain safe.
- A blocking review quarantines only a PO/TO that is newly placed or moved. It
  does not reject an unrelated Dispatch edit, metadata refresh, pickup-stop
  regeneration, or removal of the reviewed order.
- Automatic reconciliation continues through the existing transaction,
  immutable audit, schedule projection, and review-resolution paths. It does
  not post IF/IR and does not write to NetSuite.

## Verification

- Complete isolated MBT: 429 files and 2,122 tests passed.
- Reconciliation policy/integration/planning isolation: 14/14 passed.
- Focused stale Dispatch and PO Split regressions: 23/23 passed.
- Schedule remarks: 32/32; phased PO Split: 59/59; PO status consistency:
  23/23; schedule loading: 8/8.
- Dispatch save coordination, memory bounds, post-commit warnings, schedule
  weight/status, and legacy browser syntax harnesses passed.
- TypeScript and focused zero-warning ESLint passed; `git diff --check` passed.
- Mutation testing killed 4/4 Dispatch stale-lock mutants, 15/15 PO Split UI
  mutants, and 12/12 reconciliation mutants. Each runner verified source
  restoration.

The independent legacy baseline passed all reconciliation, Dispatch, memory,
PO/TO, and Driver-PWA evidence harnesses reached before `test:pwa-i18n`. That
later harness reports nine Chinese dictionary keys already missing in `HEAD`;
`operator.js`, `i18n.js`, and the harness itself have no working-tree changes
in this release. The unrelated translation baseline defect was not altered.

## Backup and short cutover

- Validated custom PostgreSQL archive:
  `docker/backups/mbbs-before-reconcile-stale-ui-20260829T024112Z.dump`,
  239,409,613 bytes, SHA-256
  `ed0ffbb42d7fa5d5ea330d74a1565cf0df58a64012144e2126be450f87949059`.
  `pg_restore -l` validated its 3,069 TOC entries.
- Pre-cutover rollback images:
  `mbbs-operator-app-app:rollback-20260829T024112Z` at
  `sha256:a521b21fa5704b68263c0c2b364efd2c0f6b6dd499a2e7aed7338290f131b568`
  and `mbbs-operator-app-webhook-worker:rollback-20260829T024112Z` at
  `sha256:561ed980096ca2738d894cfe37b4dd5f5c447c274a15d348a13a285e65a44596`.
- Release images:
  app `sha256:81f722dbf29e17eb38f95b92c91773c135ffa54dfdf508fc7296da67ef0a9b6d`
  and worker
  `sha256:4c7e83413d6ba4ad4ddc0a7d715ca252f81141e95b122d24240ad617f3fcf139`.
- Images were built while production remained online. Only app and worker were
  recreated; the Compose cutover completed in 6.3 seconds end to end, while
  PostgreSQL and Ollama stayed up. `/health` returned 200 and both startup logs
  were error-free.
- Migrations 185 through 190 were already recorded and the migration command
  completed as a no-op. Dispatch catalog state is ready with assignments ready;
  the PO catalog is ready with 888 rows and no error. The webhook inbox has no
  queued, running, or failed work.
- Deployed cache keys and source markers were fetched over the live HTTP
  endpoint for the Dispatch stale-lock fix, PO Split authoritative-row update,
  responsive two-row grid, and both NetSuite destination labels.

## Targeted production reconciliation

The pre-apply query found exactly the six reproduced false blocking cases:
`TOB00964`, `TOB00973`, `TOB00989`, `TOB00994`, `TOB00995`, and `TOB00996`.
An unrelated scheduled run held the global reconciliation slot, so the repair
respected the concurrency guard and waited for run 628 to succeed.

Dry run 629 processed 6/6 with zero review, failure, or unresolved reference.
It proposed effective Completed for `TOB00964`/`TOB00973` and Queued for the
other four. Apply run 630 then processed the identical six-order set through
the normal service with zero review or failure.

Post-apply proof:

- all six order states are `reconciliation_status = ok` and `last_run_id = 630`;
- all six original blocking cases are resolved by `auto_resolve` and the six
  schedule projections have `reconciliation_blocked = false`;
- run 630 wrote 12 immutable accepted audit events, one propose and one apply
  event per TO;
- `TOB00964` and `TOB00973` appear in Completed history with effective status
  Completed; `TOB00989`, `TOB00994`, `TOB00995`, and `TOB00996` appear in the
  active schedule as Queued; and
- the targeted open blocking-case count is zero.
