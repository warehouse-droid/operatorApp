# PO item weight evidence

Spec: [po-item-weight-spec.md](po-item-weight-spec.md). Spec approval was not
obtained (autonomous run under the user's request). Confidence is bounded by the
recorded scenarios and known limits; this is not independent spec review.

## Production finding and immediate correction

POB03658 is NetSuite PO 936958. Its 39 source lines were last synced at
2026-09-18 18:50 UTC. At 18:59 UTC the item master had newer weights, but existing
PO line weights had not been propagated. Three lines (items 5169, 5173, 5174:
TV80S Storm, Platinum, Dune) still held 26.08 lb/SQFT while both the item master
and a fresh NetSuite read returned 36.6459 lb/SQFT.

The requested first refresh corrected those three source weights at 19:08 UTC.
A later read of all active linked splits found seven additional stale copies.
The tested correction updated those seven copies. All 210 parent and split lines
then matched the fresh NetSuite source. Full before/after row comparisons proved
all fields other than item_weight stayed unchanged. All eight targeted Dispatch
and SCM catalog refreshes completed. These were local metadata corrections;
no NetSuite transaction or item record was written.

Durable repair details and before/after assertions are recorded in
`/home/ubuntu/operatorapp-deploy-backups/po-item-weight-20260918-v1/live-refresh-initial-splits.json`
and the existing `netsuite.purchase_order.item_weight_refresh` audit events.

## Final behavior and acceptance mapping

- Ordinary and bulk inventory sync detect parent or active split weight drift,
  then enqueue the original NetSuite PO in the existing durable refresh queue.
  Matching rows, inactive rows, unrelated items, and duplicate jobs are covered
  by `po-item-weight.test.js` database tests in `test/mbt/integration`.
- The delayed PO worker reads current NetSuite details and changes only weights
  on matching PO/line/item identities and active linked splits. Named unit tests
  cover read-before-commit ordering, errors, stale leases, and SO/TO isolation.
  The production-wiring test checks both callbacks are configured.
- Real database tests verify PO/split display totals, every other line field,
  split ledger preservation, null/zero handling, idempotence, correction audits,
  transaction rollback, and catalog refresh enqueueing.
- A real two-connection PostgreSQL test changes an item while a correction is
  blocked on its row lock. The item-identity recheck prevents stale metadata
  from being attached to the new item. Existing delayed-worker integration
  tests cover lease fencing and atomic finalization.
- Two generated-property tests exercise decimal/ID normalization, idempotence,
  nonnegative weights, quantity independence, and duplicate rejection (250
  generated examples total, seed 3658).
- Metadata-only scope and no new balance/fulfillment writes are also checked by
  reviewing the four-file release patch and the production protected-row hashes.

## Reproduction and verification

Entry point: `sudo -n bash tools/po-item-weight-gauntlet.sh`.
The runner uses the existing Node 20.20.2 Docker test image, temporary PostgreSQL
18, c8 12.0.0, ESLint 10.8.0, TypeScript 7.0.2, and fast-check 4.9.0. It adds no
dependencies and compares type/test diagnostics with the preserved pre-fix
baseline. Source manifest: `test-artifacts/po-item-weight/final/source.json`.
Canonical manifest SHA-256:
`ae6026ee40696657730df33aef595d1834aa8b4cf64986e212198bbc3ef2e79a`.

- RED: 16 of 17 initial tests failed against stubs or existing behavior. One
  pre-existing SO/TO isolation case passed and was later proven sensitive by the
  `read_po_weights_for_so` mutant. A separate real-lock RED test failed with
  `1 !== 0`, demonstrating the concurrent-identity bug before its guard.
- Final focused run: 50 tests passed, zero failures.
- Changed executable lines: 116/116 covered. The new module additionally has
  132/132 lines, 7/7 functions, and 39/39 branches covered.
- Manual mutation: all six plausible bugs were killed: retained stale weight,
  wrong item match, omitted splits, scaled weight, missing lock-time identity
  guard, and accidental PO reads for SOs. Attribution is to the combined focused
  suite, not a claim that properties alone killed all six.
- Static checks: zero lint diagnostics and zero new type diagnostics; the
  baseline has 243 existing type diagnostics. Syntax and complexity checks pass.
- Suite health: all eight focused test files passed in deterministic shuffled
  order (seed 3658).
- Full suite: 2,825 tests; 2,805 passed, 19 pre-existing failures, one skipped.
  Zero new failures compared with the pre-fix baseline. All 18 added tests pass.
- Dependency hashes are unchanged. Secret scan and source verification pass.
  The first secret scan flagged the synthetic test lease string. A comment
  identifying that deterministic fixture resolved it. The exact before/after
  comparison in `fixture-comment-verification.json` proves no runtime or assertion
  change since the full run; all eight affected unit tests were rerun successfully.
  The full suite predates that comment-only correction; its runtime code and
  assertions are identical. The affected unit, secret, and source checks were
  rerun to complete the final gates.

The pre-fix baseline recorded 2,807 tests: 2,787 passing, 19 failing, one skipped.
Failure names are retained in `test/support/po-item-weight-baseline-failures.json`.
Unrelated pre-existing failures were not edited or suppressed.

## Release and limits

Candidate image: `mbbs-operator-app:po-item-weight-20260918-v1`, immutable ID
`sha256:5576e1308221bb68b1ef8fc7c00cb0a8348a3657253263a813c5272876fc2ffd`.
It overlays only inventory-repository.js, netsuite-delayed-status-refresh-service.js,
purchase-order-weight-refresh.js, and server.js on the running kit-fix image.
No migration, frontend, package, environment, or dependency-service change is
included. The unchanged webhook worker already enqueues the delayed PO checks;
the application owns the updated delayed worker and inventory sync.

Release commands are implemented in `tools/po-item-weight-deploy.py`:
`prepare`, `build`, `check`, `preflight`, `apply`, `refresh`, and `verify`.
`refresh` runs the same protected-field correction against POB03658 and its
linked splits; read-only preflight checks are separate.

Deployed successfully at 2026-09-18T19:40:52.824611+00:00. Candidate: all 50 focused tests
passed against the exact packaged source. Live post-deployment verification
confirmed all 210 parent/split lines match NetSuite, local and public health
return HTTP 200, anonymous Delivery access remains HTTP 401, all four runtime
file hashes match, application configuration is preserved, and dependency
containers are unchanged. Deployment details and rollback metadata are retained
in `/home/ubuntu/operatorapp-deploy-backups/po-item-weight-20260918-v1/`.

No new browser test was added: there is no frontend change, and real database
reader tests verify the computed parent and split display weights. No dependency
audit was rerun because both package manifests are unchanged; the gauntlet checks
their hashes and scans the scoped patch and tooling for secrets. No new migration
or rollback rehearsal is needed; the image release retains the old image and
checks configuration/source hashes with rollback on failed verification.

Freshness follows successful NetSuite reads and the existing queue/sync cadence.
PO webhooks enqueue a check after 10 seconds, serviced by the existing 5-second
poll. Item-only edits are detected when the item next syncs or its PO refreshes;
there is no new direct item webhook subscription. Failed reads use the existing
bounded retry policy and retain visible failure records if retries are exhausted.
