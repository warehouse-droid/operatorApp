# Backorder supply status controls — 2026-10-28

The SCM material review now includes **Stock available at destination yard** in
the Supply status dropdown. Its separate form, heading, button and explanation
were removed. Selecting it hides and disables vendor review fields; switching
back restores them. Save material review uses the existing revision-checked
yard-stock completion action. Purchasing and dispatch eligibility remain enforced.

SCM Backorder details now show **Refresh stock evidence**. It uses the existing
evidence endpoint to reload destination-yard quantities from the current inventory
mirror. Sales views retain their existing controls. The SCM asset cache keys were
updated. The release changes three public assets and no server code or schema.

Validation: **29 passed, 0 failed, 0 skipped** across the existing review-flow
unit/property tests and five browser/integration suites. Coverage includes selecting
and saving without a vendor, switching back to vendor/Already Ordered statuses,
mobile layout after sidebar resizing, Sales visibility of completion, refreshing
changed inventory quantities, request revision preservation, and existing workflow
guards. Both edited JavaScript assets passed syntax checks. Browser selectors were
updated for the existing nested SO-reference layout and asynchronous sidebar resize.

Tests used the bounded `docker/run-dispatch-source-tests.sh` configuration under
`mbbs-tests.slice`, wrapped by the retention runner with a unique
`MBBS_TEST_ARTIFACT_DIR`. Every run, including failed diagnostics, removed its
containers, database storage, network and generated logs/browser artifacts. The
runner checked both running and stopped containers and production health.

The release records are under
`server/deployments/backorder-supply-status-20261028`, with the exact source hashes,
test receipt, scoped patch and rollback metadata. After the user explicitly
requested **deploy**, the tested image was published to the live application.
All three assets matched the tested source through both local and public HTTP
checks. Application health passed; configuration and the other production
services were preserved. No new test environment was created for deployment.
