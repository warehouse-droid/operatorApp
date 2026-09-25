# POB03669 PALLET reconciliation data repair

Scope approval: the user requested "help me to do this" after reviewing the
three source-line corrections and restoration of the affected quantities.
Separate executable-spec approval: not obtained (autonomous run).
Tier 3: inventory identity and atomic production data correction.

## Acceptance criteria

1. Require PO 939701 / POB03669, item 1784 / PALLET / EACH, active split
   ledgers 450 / SN1399039, 454 / SN1399065, 463 / SN1399105 and
   475 / SN1399337. Read fresh NetSuite evidence before applying.
2. Verify existing receipts IR14242 (969277), IR14245 (969704) and IR14288
   (972610) identify the named splits, quantities 22, 23 and 28, and source
   orderLine 34. Reassign those three ledger and child source identities from
   local source 127428 / key 4737073 / orderLine 8 to local source 368856 /
   key 4851536 / orderLine 34. Persist the child netsuite_order_line as 34.
3. Verify IR14239 (969017) identifies SN1399065, quantity 40, source orderLine
   8. Restore that ledger and child quantity from 18 to 40, retaining line 8.
   Restore SN1399105 and SN1399337 from zero to 23 and 28 and reactivate
   those child rows. Original requested quantities remain the authority.
4. Reconcile current receipts, including IR14645, using the existing
   reconciliation functions. Resolve the blocking review from evidence.
   Do not accept/dismiss a still-conflicting review or create NetSuite records.
5. Source PALLET capacities stay 249 and 341. Corrected active split current
   quantities total 249 on line 8 and 241 on line 34; no capacity or baseline
   increase. Preserve other split ledgers, item rows, operator confirmations,
   receipt history, destinations, holds, dispatch assignments and completions.
   Reconciliation-derived flags, allocations and progress may update.
6. Lock the PO family and relevant reconciliation rows, refuse an active
   posting or changed preconditions, and apply all changes atomically. Record
   before/after evidence and a repair audit using a transparent system actor.
   Repeated execution recognizes the repaired state without repeating edits.
7. Rehearse against the real database inside a transaction that rolls back;
   compare before/after state to verify rollback. Deliberately wrong source,
   quantity and orderLine variants must fail before commit. Compare a second
   reconciliation for stable results, then verify committed state by fresh reads.

## Failure model and checks

| Failure | Check |
| --- | --- |
| Wrong order, split, item or NetSuite line | Exact IDs, memo/ref, item/unit and receipt assertions |
| Stale data or concurrent posting | Snapshot comparison, row locks, active posting check, bounded lock timeout |
| Partial correction | Single transaction, injected faults, rollback state comparison |
| Capacity error | Per-source totals, exact restored quantities and unchanged baselines |
| Lost planning/operator evidence | Before/after comparisons of unrelated rows and protected fields |
| Review cleared without resolving cause | Empty reason, zero open blocking cases, exact four receipt allocations |
| Repeated repair | Detect repaired state and verify without another mutation |
| Silent or unreproducible operation | Persisted runner, private before/after snapshot and evidence report |

## Setup and calibration

Use existing deployed Node/PostgreSQL modules and Python standard library.
No dependencies, schema, application code, NetSuite scripts, commit or deployment
are needed. Add only this spec, a scoped repair runner and an evidence report.
Keep operational snapshots outside Git under a private backup directory.

This is a targeted data repair. Full application suite, application types,
browser tests and dependency audits are not applicable to a runtime code diff
because there is none. Validate the runner with syntax/static checks, actual
transaction rehearsal, negative mutations and state invariants; report other
gauntlet layers explicitly rather than claiming unexecuted checks.
