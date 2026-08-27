# Evidence — authoritative SCM schedule status repair

Status: GREEN; final isolated gauntlet and live read-only audit complete.

## Diagnosis and RED proof

The read-only production diagnosis established independent faults:

- four completed `RP-*` VRMAs were recorded as PO Driver completions because
  retained Dispatch plans use `type: "PO"` with
  `sourceTable: "scm_vrma_orders"`;
- exact NetSuite `Transfer Order : Rejected` was treated as open;
- delayed status refresh did not support Transfer Orders;
- broad nightly reconciliation is disabled, so stale PO/TO schedule families
  had no bounded automatic repair path.

The first isolated focused run executed 23 tests: 19 passed and the four
intended assertions failed for VRMA identity, Rejected terminal handling, TO
delayed-refresh support, and the `TrnfrOrd` record type. Additional RED runs
proved that candidate discovery returned raw split/group/local-only aliases,
and that an already-projected `Partially Done` row could waste a refresh slot.

## GREEN proof

The reproducible command is:

```sh
npm run gauntlet:scm-authoritative-schedule-status
```

It runs in an isolated Docker database and performs:

- migrations 001 through 183 plus migration-upgrade replay;
- 44 focused unit, property, integration, concurrency, and wiring tests;
- the existing PO/TO reconciliation and VRMA rollback harnesses;
- coverage for the new bounded scheduler: 100% statements, 95.55% branches,
  100% functions, and 100% lines;
- zero-warning focused ESLint, legacy browser syntax checks, and TypeScript
  checking;
- 16/16 killed mutations (100%), with source restoration verified;
- diff secret scanning and a source-state SHA-256 manifest.

Candidate discovery now expands active groups, maps PO/TO split aliases to the
positive canonical NetSuite family, deduplicates aliases by source ID, excludes
local negative-ID rows, and does not spend capacity on a newer exact projected
status. Driver-completed rows remain monotonic and excluded.

## Production population audit (read-only)

At `2026-08-27T03:13:51Z`, the audit examined all 314 rows whose persisted
schedule status is `Queued` or `Planned`:

- 280 already had a correct effective status;
- 23 displayed rows were definitely stale against current NetSuite evidence;
- 11 were legacy local-only/negative-ID or cancelled-group rows and therefore
  have no authoritative NetSuite source to reconcile.

The 23 stale rows collapse to 20 canonical source families: 17 fully received
PO rows, five displayed aliases belonging to two partially received PO
families, and `TOB00960`, which is fulfilled and `In Transit`. The fixed
selector found 39 authoritative stale families in total (the 20 corrections
plus 19 legitimate periodic revalidations) in about 0.2 seconds. No production
row, reconciliation run, NetSuite order, or deployment was changed by the
audit.

After deployment, the bounded drain will process one order kind and at most ten
canonical families per tick while yielding to operational synchronization. A
post-drain repetition of this same audit is required before claiming the live
population itself is fully green.
