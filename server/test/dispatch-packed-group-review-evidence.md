# Packed sales-order group review fix — evidence

Date: 2026-09-16 UTC. Tier 2, scoped dispatch projection fix.

Spec approval: not obtained (autonomous run). User requested the general fix
following the live diagnosis. See [acceptance specification](dispatch-packed-group-review-spec.md).

## Result

Deployed `mbbs-operator-app:dispatch-packed-group-review-20260916-v1`, image
`sha256:8347c79f964bcc84e601d53031c402004af557290a61b5a9802171fd5dfac93b`.
Only `src/dispatch-plan-repository.js` differs from the prior production image.
The app is healthy; environment, mounts, ports, worker and dependency containers
were preserved. Existing IF/IR, split-date and Android-spacing changes remain in
the base image.

A packed SO without a preparation lock no longer creates a synthetic group
review from its retained confirmed quantities. Actual preparing work, locks,
unfinished open-order progress and stored reconciliation problems retain their
existing protection. Authoritative reconciliation writes still respect packed
work. No NetSuite transaction or source-quantity changes are part of this fix.

The validated cache refresh cleared only review fields for five existing groups:
GOA-6859-6860, GOA-8601-8604, GOB-118192-118370-118607,
GOB-119238-119239 and GOB-120487-120489. Both reported groups read as Queued and
unblocked through the live plan repository. The private before snapshot and
release records are under `backups/dispatch-packed-group-review-20260916`.

## Acceptance mapping

| Behavior | Verification |
|---|---|
| Packed and confirmed members remain available | New database regression for a fresh group |
| Old false warnings clear on reload | Stale snapshot test; repeated reads and exact source/snapshot comparison |
| Correct status reaches the global card | Normal group sync, catalog lookup and stored card assertions |
| Real review/missing/error retained | Three database scenarios with exact reason assertions |
| Preparing, locks and unfinished progress protected | Three negative controls; existing grouped SO integration harness |
| Packed work protected from reconciliation | Real activeSalesOrderFamilyDraft query and source-state comparison |
| Partial/completed groups retain their rollup | Mixed and fully fulfilled member scenarios |
| Existing cache refresh is narrow and repeatable | Real-review control, exact non-review field comparison, unchanged source records, repeat no-op |
| PO/TO and grouping behavior preserved | Grouped PO integration, global group integration/property checks |

## Final verification

Entry point: `sudo bash server/tools/dispatch-packed-group-gauntlet.sh` from the
repository root. It uses the existing `mbbs-retired-confirm-test:20260914` image,
Node 20.20.2, installed pinned tools from package.json/package-lock.json and a
fresh isolated PostgreSQL 18 database. No new dependencies were installed.

- Focused suite: **18 passed, 0 failed**, including 12 new database scenarios.
- Changed production conditions: **2/2 executed** (lines 1096 and 1099).
- Manual mutation: **11/11 killed by behavioral assertions**. Includes accidental
  packed blocking, loss of real review/draft safety, unsafe cache clearing,
  changed quantities and omitted cache writes.
- Existing property suite: 12 generated global-group cases across SO/PO/TO.
- Suite order check: focused files executed separately in reverse order; passed.
- Full MBT baseline and final: **2,580 tests each; 2,578 passed, 1 failed,
  1 skipped**, across 505 files. **Zero new failures**.
- Typecheck: **233 existing diagnostics in both runs; zero new diagnostics**.
  The legacy JavaScript projection itself is validated through syntax, lint and
  real database execution; it is not covered by the repository's typed module list.
- Scoped source/test/tool lint and syntax: passed.
- Secret scan, capability review and `git diff --check`: passed. The deployed
  change adds no I/O capabilities. The maintenance tool changes only derived
  group review fields in one transaction with row locks and bounded timeouts.
- Candidate: isolated migration/startup/health smoke passed, then a read-only
  production replay identified all five eligible cache corrections.
- Deployment: live source hashes and configuration checked; both user examples
  returned Queued/unblocked. Cached review fields were refreshed after backup.

Runtime source SHA-256: `3c6cf52d100103fe15747ee102236d238bfffadd0c438f3850bdb44df0f70f0a`.
Cache-refresh tool SHA-256: `02511994d685cd6b4c5b5be6e1604ad06bd2a6beda1ed778236d6f39d1076eb6`.
Detailed logs, coverage and mutation outputs: `test-artifacts/packed-group-review`.
Deployment command: `sudo python3 server/tools/dispatch-packed-group-deploy.py apply`.
The release tool requires the completed baseline/final full-suite logs, verified
source hash, focused pass, 11 killed mutants and unchanged type diagnostics.

## Baseline failures and limits

The unchanged main-suite failure is `P3.12: browser specs share one worker-owned
database-pool lifecycle`. Separate legacy checks also fail identically before
and after: the SO mapping harness expects no netsuite_order_line attribute; the
SO integration harness expects familyCount 1 at line 555 but receives 0; two
global derived-order cases dereference null type/childOrders. These assertions
were retained and their before/after failures compared, not weakened.

The initial new suite reproduced six failures before the runtime edit. The cache
maintenance scenario was added afterward and validated with database execution
and three dedicated fault mutations. An initial maintenance-helper lint failure
was fixed by extracting small functions. A redundant raw-harness log comparison
could not parse Node's assertion output; the final workflow uses node --test
baseline comparisons for those legacy cases.

New browser layout tests and dependency/license audits were not run: this is a
server status projection with no UI assets or dependency changes. Existing UI
status harnesses ran. There is no production migration. Concurrency preservation
uses existing row/transaction locks and full-suite concurrency regressions;
there was no production concurrency stress test. Production cache snapshots stay
private because they include operational order details.
