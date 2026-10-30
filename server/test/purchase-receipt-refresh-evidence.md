# Receipt refresh evidence — 2026-10-27

Spec: [purchase-receipt-refresh-spec.md](purchase-receipt-refresh-spec.md).
Spec approval: not obtained (autonomous run). Tier 3. No new dependencies.

Reproduce with `bash docker/run-purchase-receipt-checks.sh` from the repository.
Final validation: `server/deployments/backorder-po-receipts-20261027/validation.json`
identifies all eight released file hashes and the recorded toolchain.

- 223 tests: 196 passed, 27 unchanged baseline failures, zero new failures.
  The two Direct PO materialized-split suites require an unrelated migration
  absent from the live baseline. Running unchanged live source reproduced the
  identical 27 failure names; assertions were not weakened.
- Focused reverse order: 18/18 passed. Changed executable lines: 166/166;
  changed branches: 60/64. Types, lint, syntax, complexity and diff secret checks:
  zero new findings.
- Four intentional bugs killed by both regression and property-only suites:
  dropped child-to-root mapping, dropped receipt quantities, dropped rerun signal,
  and leaving fully arrived requests In Progress.
- Real tests cover signed IR HTTP ingress with reconciliation already busy,
  durable queue writes, followup receipt during worker execution, two-connection
  finish/save races, migration repeat/rollback, cold startup and Sales/SCM views.
  A discovered lock-order deadlock was fixed before the final fresh run.

Deployed `mbbs-operator-app:purchase-receipt-refresh-20261027`; live health and all
eight file hashes verified. Subsequent independent releases preserved the fix.
Targeted reconciliation run 5993 repaired all five source POs for requests 133,
163, 165 and 186. The subsequent durable refreshes succeeded and all five POs
show receipt_status=received. STREQ-000163 displays Completed with two arrived
materials. No customer SO fulfillment or separate production work was forced.

Production evidence is retained under the deployment directory, including
`repair-run-audit.json`, `post-deploy-refresh.json`, and `final-receipt-audit.json`.
Tests used bounded disposable Compose projects in mbbs-tests.slice; each run
removed its containers, volumes, networks, logs and generated artifacts. Both
container listings and production health were checked after teardown.
