# CO direct TO cargo and Packed visibility

Spec approval: not obtained (autonomous run). The user authorized direct linking
of untouched lines, clearing source SO packing, preserving packing on the CO,
and linking exactly 1 of 7 pallets to TOB01102 with 6 remaining on the CO.
Tier 3 applies because operational quantities and concurrent packing are involved.

Acceptance criteria, recorded before implementation:

1. Linking an untouched 52.25 SQFT / 5 layer Trevista line directly to a TO removes
   that quantity from the source-yard CO's operational manifest. Its original
   requirement remains recoverable when an unstarted link is removed.
2. Linking 1 of 7 pallets leaves exactly 6 on the CO. SO demand and TO ordered
   quantities do not change. Other packed CO lines and confirmations are exact.
3. Creation after linking, repeated linking receipts, CO refreshes, and repeated
   reconciliation do not double-subtract or resurrect direct cargo. Yard
   replenishment does not remove CO cargo; switching back restores the requirement.
4. Operator Packed lists an ownerless pending CO with confirmed packed lines;
   its remaining quantities also appear in Active. Packed detail contains the
   packed lines; Active detail contains the unfilled quantities. Underpack counts
   and load eligibility agree with detail. An owned preparation stays a draft.
5. Loaded/received/completed cargo is immutable to this reconciliation. Changes
   affecting packed/confirmed lines or an operator-owned draft are rejected
   atomically. Existing operator/consolidation locks serialize competing writes.
6. Canonical CO quantities drive Dispatch projection, including an empty
   operational manifest. Existing independent CO manifests and PO allocations
   retain their established behavior. No other SO, TO, CO, or plan is repaired.
7. Live SOA08838 retains its cleared source packing; CO-SOA08838 retains its five
   packed lines, excludes Trevista, and has 6 remaining pallets. TOB01102 has
   allocations for 52.25 SQFT Trevista and 1 pallet. Verify actual Packed/Active
   list membership and detail filtering, not just order-detail availability.

Failure model and checks: duplicate subtraction/lost cargo (idempotence and
generated conservation tests); erasing packing (exact-row comparisons);
partial writes (transaction rollback); concurrent packing (real database locks);
wrong-line matching (canonical source IDs and ambiguous fallback rejection);
stale snapshots (canonical projection); hidden or unloadable packed cargo
(repository and real Operator UI tests); repair drift (guarded dry run, private
backup, atomic application and postcondition checks); release regressions
(baseline comparison, scoped image diff, health and rollback rehearsal).

Setup: reuse installed Node 20, PostgreSQL 18, fast-check, c8, ESLint,
TypeScript and Playwright in the existing test image. No new dependencies,
migrations, git commits or stashes. Add scoped tests, reproducible gauntlet,
guarded repair and deployment tools. Use disposable databases for test writes.
Preserve unrelated workspace edits and deploy only the verified runtime files.
# 2026-09-17 Operator visibility amendment

The user's subsequent clarification requires a fully direct-supplied CO line to
remain visible as a non-packable Operator reference. The prior expectation that
Trevista be absent from Operator detail is superseded by
[co-supply-reference-spec.md](co-supply-reference-spec.md). Its physical CO cargo
must still be zero and absent from Dispatch's transport manifest. Display line
count now includes the reference; workload and packed quantities do not.
