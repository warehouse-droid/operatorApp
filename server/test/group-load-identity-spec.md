# Grouped delivery identity regression

spec approval: not obtained (autonomous run)

User request: fix loading GOA-8601-8604, which fails with PostgreSQL 22P02.
Production traces also identify the same group's line-unpack audit failing on a
GRPLINE identifier. Both are virtual text identities, not canonical bigint IDs.

Tier 3 operational write-path change. Keep the existing transaction, locking,
CO handoff, quantity, photo and audit policies. No new dependencies or schema
changes. Do not load, unpack, post to NetSuite, or alter the user's live cargo.
Preserve unrelated work and layer only the two changed modules over the current
app image; the worker has a different source version and is outside this fix.

Acceptance:

1. A packed sales-order group with a GOA text ID loads both canonical children,
   retaining exact quantities, per-child load records and the group audit.
2. A live source-yard CO belonging to any child blocks the whole group with
   CO_SOURCE_PACKING_HANDOFF. Child ordering cannot bypass this protection.
   Cancellation and different-yard COs retain their existing behavior.
3. Standalone sales orders and grouped transfer orders keep working. An invalid
   child prevents partial group writes.
4. Unpacking a GRPLINE clears only its actual source lines, retains unrelated
   packing, and records the virtual ID in audit details with no numeric line ID.
5. Failure to write the group audit rolls back all unpack changes.

Evidence: reproduce both 22P02 errors before implementation using real PostgreSQL;
run focused and adjacent suites before/after in normal and reversed file order;
compare existing type/lint findings; check changed-line coverage and mutation
sensitivity; verify production source hashes and read the affected order before
and after deployment without modifying it. Retain a rollback image and manifest.
