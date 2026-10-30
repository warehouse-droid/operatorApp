# Stock return layout follow-up

Deployed successfully. All three live file hashes match the tested release;
production health, application configuration, and the other services passed
verification. No database migration was needed. Deployment time and image
identity are recorded in
`server/deployments/return-layout-20261028/deployment.json`.

The release contains only `public/operator.js`, `public/operator.css`, and the
operator page's asset cache keys. Its final behavior is:

- Two stock balance tiles per row.
- Two physical-unit boxes per row, with the unit/conversion above the stepper.
- Adding a quality reason retains app, editor, item-list, and page scroll positions.
- Item cards omit fulfilled quantity and source-line labels.
- Quality reason rows omit the short-note input. Existing saved row data is retained.

The exact candidate passed `sudo -n bash server/tools/run-return-layout-checks.sh`:
three existing UI cases and fourteen Chromium cases, including widths 320, 390,
768, 1024, and 1440; physical and sales-unit inputs; twenty reason additions;
two-column alignment; conversion headings above steppers; no unit-box overflow;
minimum 15px text; and existing required-photo blocking/toast behavior.
The browser fixtures run the application's actual rendering and add-reason
functions with synthetic data. No NetSuite writes or customer messages occur.
JavaScript syntax, shell syntax, and whitespace checks passed.

The release was rebased onto `mbbs-operator-app:dispatch-search-20261028` after the
deployment guard detected a concurrent release. The final candidate was checked
again. Exact source hashes and validation results are in
`server/deployments/return-layout-20261028/validation.json`.

Tests used the standard isolated Compose configuration with bounded resources in
`mbbs-tests.slice`, no database, and the retention runner's unique artifact path.
The test container and network were removed after every run; both Docker
container listings and production health passed after cleanup. Only concise
source evidence and operational release/rollback records are retained.
