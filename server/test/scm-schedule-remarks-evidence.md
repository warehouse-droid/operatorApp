# Evidence — PO / TO schedule remarks

Status: GREEN and deployed to the production application on 2026-08-27 UTC.

## RED proof

Before implementation, the six new acceptance checks all failed. The product
had no dedicated schedule remark, no TO Memo fallback, no remark column after
`Content`, no shared PO Split editor, and no safe write path for a locked split.

## Implementation proof

- Migration `184_scm_schedule_remarks.sql` adds one nullable, length-constrained
  `remark_override` column to the shared `scm_transport_schedule` record.
- PO / TO Schedule and PO Split read and write that same field.
- Transfer Orders resolve a blank local override to the latest mirrored
  NetSuite Memo; PO and VRMA rows do not inherit source memos.
- The remark-only endpoint retains optimistic revision checks, audit/event
  evidence, and the reconciliation blocker. It can update a planned split
  without changing its route, quantities, status, planning note, or revisioned
  operational state.

## GREEN proof

The focused suite passed 28/28 tests, including column placement, both editors,
locked split behavior, cache keys, precedence, clearing an override, length
boundaries, and mixed-patch rejection.

The isolated PostgreSQL rollback harness additionally proved:

- TO Memo fallback, local override, and clear-to-fallback;
- stale-revision rejection;
- a planned split remark-only update preserves status, route, assignment note,
  split quantities, and operational revision;
- a mixed remark/operational update remains blocked; and
- the full PO Split query reads the same shared remark.

Quality gates:

- domain coverage: 100% statements, 91.66% branches, 100% functions, 100% lines;
- mutation score: 4/4 killed (100%);
- focused ESLint: zero warnings;
- TypeScript (`typecheck:mbt`): pass;
- migration-upgrade replay through migration 184: pass;
- diff secret scan: pass.

Neighboring regressions also passed: phased PO split 54/54, authoritative
schedule status 44/44, and split receipt allocation 14/14.

## Production deployment

- Production image: `sha256:a4c5c9311c1e2bd42db419fe518031b335919fc688c7d9cc390b246dc884075e`.
- Migration `184_scm_schedule_remarks.sql` applied successfully and its receipt
  was verified in `schema_migrations`.
- The app-only container replacement completed in 1.71 seconds; PostgreSQL and
  Ollama were not restarted.
- `/scm/POTOschedule` and `/scm/POsplit` both returned HTTP 200 and served the
  shared `20260827-schedule-remarks-v1` cache key.
- The application, PostgreSQL, and Ollama containers were all healthy after
  cutover, and startup logs contained no runtime error.
