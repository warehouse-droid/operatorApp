# Dispatch and Stock Request database contention

Spec approval: not obtained (autonomous run). The user authorized clearing the lock backlog and fixing its cause. Use the existing isolated Node/Postgres runner; no new dependencies, commits, NetSuite calls or commercial writes.

Measured failure: nine shared application connections waited for the fleet advisory lock. Subsequent samples drained naturally. SQL under that lock repeatedly scanned 14,765 Sales Orders for case-insensitive identity counts and 1,138 Purchase Orders for each of 272 completion records. Matching expression indexes are missing; the existing indexes use upper(), while these queries use lower().

Acceptance:
1. Both Sales Order reference and textual internal-ID predicates have valid, nonunique B-tree expression indexes; all three Purchase Order alias predicates have equivalent indexes. Preserve duplicate identities and all existing comparisons exactly.
2. Reapplying the migration is harmless. Applying and rolling it back on the isolated database is rehearsed. Live installation uses CREATE INDEX CONCURRENTLY, bounded lock/statement waits and validates definitions before recording the migration. No transaction/order rows are changed.
3. The same production read-only status/completion queries return identical results before and after and execute substantially faster (target each profiled query below 200 ms, measured independently from page latency).
4. Existing Driver completion/planning and Special access tests still pass. Fleet locks and revision/Driver completion guards remain intact; no production backend is killed and no active save is cancelled.
5. Monitor the live shared pool and time application endpoints after installation. Report any remaining bottleneck separately rather than treating SQL timings as page timings.

Tier 2 for this additive index-only fix: it changes query execution plans, not business behavior or lock policy. Failure model: wrong expression or missing OR-join branch leaves scans (index-definition tests and EXPLAIN); blocking live writes (concurrent creation and timeout); accidental data changes (DDL-only installer, read-only profiles and business hashes); changed ordering/identity (compare normalized results and existing duplicate/closure/Driver checks). Reuse existing integration/concurrency suites. Static JS checks apply to diagnostic/deployment tooling; JavaScript line coverage is inapplicable to the SQL-only runtime change. The actual migration is executed in PostgreSQL.

Additional user request: the acknowledged “4 source updates reviewed” notice must be dismissible. The dismiss button hides only acknowledged review tokens for this plan and the ordinary route notice; pending reviews and errors stay visible. Dismissal survives refreshes/reloads, does not hide newly reviewed changes or another plan's history, works outside Edit Mode, and does not submit a save or acknowledgement. Browser storage failure must not prevent in-memory dismissal. Preserve the existing source-review audit records. Verify in the real browser and deploy only the frontend delta plus the already-applied migration file.
