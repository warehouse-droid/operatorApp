# Sales split allocation blocker and unsplit correctness

User priority: repair SOM06964 first (completed operationally), then general fixes.
Autonomous Tier 3 run; spec approval not obtained. No new dependencies or schema.

1. A Sales Order with an active PO allocation or TO dependency cannot start a new
   split. The preview/numbering path explains what must be unlinked. Persistence
   rechecks authoritative allocations under the shared fleet transaction lock,
   including direct/stale plan submissions and replacements of split quantities.
2. Cancelled links do not block. Ordinary saves of unchanged established splits
   with valid allocations remain possible. A completed sibling's own allocation
   must not prevent resplitting an unrelated unfinished sibling.
3. Unsplit can restore an untouched full family whose legacy sales-only split
   omitted descriptive packing counts on non-inventory lines with no conversion.
   Sales quantities and valid converted packing counts must still balance exactly;
   unknown/duplicate/invalid lines and real discrepancies remain blocked. Restore
   the canonical parent's original quantities rather than summing incomplete child
   display metadata. Existing activity, permissions, lease, lineage and race guards
   remain in force; no partial writes on failure.
4. A restored locally reopened Billed order immediately returns authoritative
   local-open planning fields, and retired children cannot reappear on refresh or
   a stale save. NetSuite billing and completed sibling history are conserved.

Failure model: dropped allocations (database negative/positive controls and real
HTTP persistence); link/split race (real shared PostgreSQL lock contention);
quantity loss (conservation properties, adversarial cases, normal unsplit service);
history damage (existing delivered-sibling and atomic rollback suites); stale flags
(audited Billed reopen/unsplit integration); release drift (exact live capture,
narrow overlay and unchanged concurrent files). Use the existing old-coder gauntlet
with baseline differential, RED/GREEN, types/lint, changed-line coverage, manual
mutants, properties, real endpoint execution, reversed test order and evidence.
No production data in tests. Standard bounded Compose and mbbs-tests.slice only;
register teardown first and remove every task test container, volume and network.

Fixture correction during RED: PO allocations require dispatch_target_line_key;
the seed now supplies the normal canonical key. Legacy targets are represented by
an empty string, respecting the current non-null schema. Behavioral assertions
are unchanged; rerun RED before implementing runtime changes.

Two failures during GREEN extend the executable specification: allocation-blocked
HTTP saves must return a conflict rather than being acknowledged as a 202 recovery
draft; and quantity identity comparisons must use the application's existing six
decimal materialization precision, so binary floating-point tails cannot create a
false stale-split error. Actual conserved quantity checks retain their existing
precision. The original failing assertions and property inputs are retained.

Verification-runner correction: the repeat suite encountered leftover accounts
and edit leases from the first run. Use the repository's disposable database
cloning helper for each phase and each reverse-order file. Node sorts a multi-file
CLI list, so execute reversed files individually to make the order change real.
Tests and runtime assertions remain unchanged. Preserve the failed run evidence.

Some legacy Control fixtures explicitly require the exact mbt_test database name.
The cloning attempt hit that safety assertion. Preserve the assertion and instead
recreate only the strictly validated disposable mbt_test database from a pristine
template between phases and reversed files. New-test mutants use independent
disposable clones per invocation. No runtime or test assertion changed.
