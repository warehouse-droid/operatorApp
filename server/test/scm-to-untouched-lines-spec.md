# TO links on partially packed sales orders

User approval: explicitly approved allowing TO links to untouched SO lines while
preserving packing on other SO lines, 2026-09-16. The implementation details below
are an autonomous refinement of that approved behavior.

Tier 3: changing an operational activity guard can reassign packed cargo or race
an operator. Use existing Node, PostgreSQL, fast-check, c8, ESLint and TypeScript
tools in an isolated disposable database. No new dependencies, schema changes,
git commits, NetSuite writes, or production order-data repairs are needed.

## Acceptance criteria

1. An explicit `link_to` allocation for an untouched SO line succeeds even when
   another line is confirmed/packed and the SO has aggregate packed/confirmed
   status. Test both direct-to-customer and yard-replenishment modes, plus an
   extension of the same TO. Preserve every source header and line exactly.
2. The selected canonical SO line remains blocked if it has confirmation,
   confirmation time, any packed quantity, or loaded quantity. A mixed selection
   containing one started line is blocked atomically. This includes pallet lines.
3. Active preparing operator/time/status and loaded/terminal SO status remain
   whole-order blockers. Loaded quantities on any SO line remain blockers.
4. Only nonempty, fully resolved explicit TO allocations receive the exception.
   Use the same key-first, legacy salesLineId fallback as relationship creation.
   Missing/invalid allocations retain the conservative whole-order check; a
   conflicting key/ID must never check a different line from the one linked.
5. Group member and split line identities resolve to their canonical SO rows;
   unrelated packing may be ignored, but selected source-line work is protected.
6. TO outbound/receiving, driver, dependency execution, closed orders, target
   signature, plan revision, edit lease and offline evidence guards survive.
   PO link/unlink, TO unlink and mode changes retain their existing behavior.
7. Commit rechecks live activity under the same order locks used by operator
   packing. Concurrent operator work must serialize; work committed first blocks
   linking. Database row updates cannot slip between the check and commit.
   Failed link commands roll back; repeated request IDs do not duplicate links.
8. Verify the live SOA08838/TOB01102 shape with read-only previews: the 52.25 SQFT
   Trevista allocation is allowed if still untouched; the existing packed pallet
   line is blocked if selected. Do not clear or reset existing operator work.

## Failure model and evidence

| Failure | Detector |
| --- | --- |
| Whole-order packing still blocks the untouched line | Real database RED regression, live read-only replay |
| Selected packing is ignored or another line is inspected | Activity matrix, hostile identities, property tests, mutants |
| Group/split identity points at the wrong row | Group/split database scenarios |
| Concurrent packing invalidates the preview | Independent database clients and actual operator lock protocol |
| Relationship failure loses packing or duplicates links | Full command, rollback injection, idempotency, exact source comparison |
| Existing guards are weakened | Existing dependency suite plus new negative controls |
| Deployment drops earlier local fixes | Build from current live image; verify only the intended source file changes |

Persist the test runner, tests, baseline patch, mutation/coverage checks and
evidence. Run baseline/final full MBT suites, scoped regressions, types, lint,
changed-line coverage, meaningful mutations, generated properties and reverse
test order. Report existing failures and every skipped layer explicitly.

Deploy only the tested preview-service change over the current app image with a
rollback image, preserved environment/mounts/ports, candidate health smoke and
read-only live verification. The user can then submit the desired link mode and
quantities in the existing dialog; this change does not choose those inputs.
