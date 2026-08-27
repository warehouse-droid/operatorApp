# Evidence — synthetic PO group rollup recovery

Status: GREEN, deployed, and the exact production target was repaired on
2026-08-27 UTC.

## Root cause and target

The two real members of `PGOB-3022094354-3022094357` are already complete:
`3022094354` has 1,885.60 ordered/received and `3022094357` has 165.24
ordered/received, totaling 2,050.84. Their synthetic schedule row retained the
legacy `Reconcile Review`/blocked state after the member review was resolved.

Three faults combined:

1. manual member resolution did not recompute the affected synthetic group;
2. group rollup persisted the blocker but did not clear a safe legacy
   `Reconcile Review` status; and
3. the UI treated `PGOB-*` as a real PO and queried source lines for that
   synthetic reference.

## Prevention and repair proof

- Member resolution and group recomputation now share one transaction.
- A cleared legacy review is replaced with the calculated group status, while
  a real operational status such as `In Transit` is never overwritten.
- Synthetic group details show member summaries and do not expose real-PO
  source-line or resolution actions.
- The repair command requires the exact group reference and exact expected
  member set, is audited, is idempotent, and does not call NetSuite or change
  receipt/allocation evidence.

The focused suite passed 8/8 tests. The isolated database rollback harness,
grouped-PO reconciliation harness, and full reconciliation repository harness
all passed.

Quality gates:

- domain coverage: 100% statements, branches, functions, and lines;
- mutation score: 4/4 killed (100%);
- focused ESLint: zero warnings;
- TypeScript (`typecheck:mbt`): pass;
- diff secret scan: pass.

## Production repair

After deployment, the rollback-only dry run confirmed the exact active member
set `3022094354,3022094357`, both members `Completed`, and only the synthetic
parent requiring a write. The apply changed
`PGOB-3022094354-3022094357` from `Reconcile Review` to `Completed`, retained
`reconciliation_blocked = false`, and created reconciliation audit event
`42604` (`schedule_group.rollup_repaired`, actor
`codex-deploy-20260827`). A second rollback-only run returned `changed: false`,
proving the repair is idempotently complete.
