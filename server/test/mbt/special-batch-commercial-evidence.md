# Special workflow batch saves and independent discounts — evidence

Spec approval: not obtained (autonomous run). User clarified the SO/PO discount split, total vendor amount, required NetSuite rep, and SPREQ-000011 material-only matching during implementation. See [spec](spec/special-batch-discount.md).

Implemented and published 2026-09-28. The application has one atomic save per SCM stock-check and Sales decision section; blank Sales choices remain pending. New SOs have a combined flat transaction discount; SCM independently confirms one vendor discount amount, including explicit zero, which is allocated to net purchase costs. The selected active NetSuite Sales Rep is stored independently of the original requester. Migration 236 is additive, with no backfill. Existing SO recovery preserves the old discount format.

Canonical reconciliation ignores NetSuite Discount/Subtotal item types, Custom Discount% 10716, and the built-in subtotal -2. Native PO matching also looks up other non-material item types without comparing SO/PO discount counts or values. Material identities, quantities, UOMs and descriptions still must match. The SPREQ-000011 pre-submission retry retains its operation ownership and requires vendor confirmation; no PO was automatically created.

Validation: 347/347 focused Special tests passed, including real PostgreSQL rollback/concurrency and authenticated HTTP checks, real Chromium desktop/mobile saves, failed-save preservation, NetSuite rep selection, exact-cent arithmetic properties, legacy/new SO boundaries, PO retry ownership, and independent discount rows. Four deliberate mutations were killed; two by generated arithmetic properties alone. Reversed focused test order passed. Syntax, scoped ESLint, financial-boundary TypeScript, and secret scan passed. Existing server lint findings were compared to baseline; no new findings. Native PO item-type optional-field typing was separately checked after the final small type fix.

Changed-line coverage is 515/535 (96.3%); branch coverage is 349/406 (86.0%). This is below the old-coder tier-3 ideal of full changed-line coverage; uncovered paths are recorded in changed-lines.json, primarily relocated existing repository rejection paths plus the draft-selector HTTP branch and defensive item metadata path. Browser coverage is merged with Node coverage. Do not describe this as complete path coverage.

Failure evidence: initial checks exposed the old per-line UI contracts, separate discount rows, newly required vendor confirmation, and native PO rejection of independent discounts. feature-initial.log and feature-second.log retain the failed runs. Fixture changes retain legacy-discount tests explicitly and add total-discount scenarios; the live SPREQ check revealed alternate discount 2022 and Subtotal -2, now covered by a database integration test that also proves extra material still blocks.

The isolated test database required an already-existing Dispatch column, mbt_assignment_withdrawn_at, to exercise existing integrations. That test-only schema repair was not published. No backup or repository-wide regression ran. No test created a live NetSuite transaction. NetSuite Employee access initially failed, then returned 36 active Sales Reps after the user's role update.

Release: 19 explicit app files layered over mbbs-operator-app:dispatch-source-replan-20260928-v2; the intervening Dispatch source-replan update is preserved. Worker release changes only reconcileCanonicalOrderLines in its own original image. Source hashes, image IDs, configuration hashes, exact migration, stage files, and worker diff are recorded under deployments/special-batch-commercial-20260928. The app and worker were healthy after deployment; DB and Ollama containers were not restarted. No git commit was created.

Reproduce focused checks in the existing isolated runner:

```sh
sudo -n docker exec -e MBT_TEST_ISOLATED=1 -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify -e PLAYWRIGHT_BROWSERS_PATH=/browsers -w /app mbbs-special-review-runner node tools/special-batch-commercial-check.mjs
sudo -n docker exec -w /app mbbs-special-review-runner node tools/special-batch-commercial-coverage.mjs
```

Primary NetSuite behavior: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2248474.html explains item versus transaction discounts. A single ordinary final discount row would apply only to its preceding row, so the combined amount uses the transaction discount. REST metadata was read to confirm discountItem, numeric discountRate, and salesRep fields.

Artifacts: test-artifacts/special-workflow-review/batch-discount-20260928 contains scoped source baselines, source manifest, runtime diff, spec test results, c8/browser coverage, mutation logs, screenshots, and the pre-release read-only financial hash. public-verification.json in the deployment folder records the live material match and before/after SOM06738 financial hash comparison.
