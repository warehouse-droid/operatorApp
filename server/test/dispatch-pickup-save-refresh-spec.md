# Pickup save refresh and CO manifest preservation

Tier 3: saved cargo data, transactional plan commands, and driver history.
Spec approval: not obtained (autonomous run); this spec is provided for review.
The first PO save reproductions predate skill activation; the following scope
also covers the subsequently reported CO manifest loss and 72-hour replay.

## Acceptance scenarios

1. A two-child SO group has 100/40 sales units and 5/2 pallets, fully allocated
   to a vendor in active PO links. Reloading an older global definition with
   zero allocated pallets must not require the empty source yard. Full and
   incremental saves retain the vendor pickup and delivery, with exact route
   IDs and allocations unchanged. Repeating a command must not increment twice.
2. With half of each line allocated, the persisted allocation is 2.5/1 pallets;
   the remaining source-yard pickup must exist before delivery.
3. Cancelled links must not resurrect stale manifests. A manually placed vendor
   pickup that is no longer valid must reject without committing a new revision
   or changing the active snapshot. This explicitly replaces the initial test
   assumption that any now-invalid manual pickup could be automatically removed.
4. Fee-only and explicitly empty physical manifests continue to skip empty
   pickups. Missing legacy details remain unknown, not proof of no cargo.
5. A standalone local CO for a grouped SO must retain its authoritative physical
   lines even when archived/global child summaries contain no line details. A
   six-pallet transfer from 2967 to 12441 must require pickup at 2967 before drop.
   Source-child metadata must not be mistaken for several independent COs.
6. Actual grouped COs retain their independent member identity, cargo, and
   cancellation rules; completed or cancelled CO history must not be revived.
7. Read overlays and replays do not alter input plans, active database records,
   or archived snapshots. Save-time route repair cannot change an executed
   prefix. Old plans with genuine invalid routes must be reported, not waived.
8. Replay saved history and captured driver/command events for the fixed 72-hour
   window 2026-09-02T04:20:00Z through 2026-09-05T04:20:00Z. Include the latest
   reported Sept 4 Li Load 4 CO and grouped-order recovery draft. Distinguish
   raw snapshot compatibility, current-authority save preparation, and actual
   isolated transactional save tests; do not call a raw validator a full save.

## Failure model and constraints

- Stale global definitions undo hydration: real incremental repository tests.
- Genuine residual cargo silently omitted: partial/cancelled allocation tests.
- Source-order child summaries erase standalone CO lines: manifest authority
  regression plus generated nested/partial summaries and adversarial cases.
- Cross-order/yard cargo leakage or duplicate items: exact manifest assertions.
- Completed stops changed by repair: driver-prefix and historical replay checks.
- Partial save or double-apply: rollback-only integration tests and replay receipts.
- Unbounded query growth: bulk lookups only; record replay and test timing.
- Secret/data leakage: read-only production capture, salted/redacted replay,
  diff secret scan, no raw credentials in output, no external data upload.

## Setup and evidence plan

Use existing Node 20 Docker runtime and installed Node test, fast-check, c8,
ESLint and TypeScript tooling. No new dependency, schema migration, git commit,
external write, production plan restore, or historical rewrite is authorized.
Keep existing workspace changes. Use a disposable tmpfs PostgreSQL test project.
Add targeted tests, a persisted repeatable gauntlet/mutation entry point and an
evidence report. Production reads run inside explicit READ ONLY transactions.
History outputs are test artifacts; no active plan is applied during replay.
Run relevant full regression suites, lint/types, changed-line coverage,
plausible mutation tests, property tests, shuffled suite order, real save
execution and the requested replay. Report unavailable layers and historical
limitations explicitly rather than claiming unconditional proof.
