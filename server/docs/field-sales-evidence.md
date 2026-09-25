# Field Sales verification evidence

The user authorized implementation of the Field Sales scope. The detailed [executable specification](../test/field-sales/spec.md) was authored during implementation: **spec approval: not obtained (autonomous run)**. It is available for review with this evidence; the implementation instruction is not treated as a separate review of every acceptance assertion. This uses the old-coder Tier 3 workflow because quotes, authentication, concurrency and offline data retention are involved. No production deployment or live NetSuite estimate was part of the test run.

The final verification run completed successfully on **2026-09-18 at 23:14 UTC**, after the last implementation and verification-tool edits. All Field Sales checks passed, with zero additional failed assertions or files compared with the existing-app baseline. Existing failures and external validation limits are recorded below.

## Reproduction and source identity

Run `bash server/tools/field-sales-gauntlet.sh` from the repository root. It builds the checked-in Docker test target, installs locked dependencies, creates isolated PostgreSQL databases and runs every automated layer. The final run reused its freshly built image with `FIELD_SALES_TEST_IMAGE=field-sales-check-2941306`; current source is mounted read-only, and the runner checks that its source hash remains unchanged during verification.

The machine-readable [checks report](../test-artifacts/field-sales/final/checks.json) records commands, exit codes, durations, tool versions, randomized file order, source file list and SHA-256. Existing workspace changes were retained. No commits were made. Test-only database credentials are generated/configured separately from application credentials, and NetSuite writes are disabled in the isolated environment.

Verified source SHA-256: `fbf6fe8c0153c74eb00a05284df732c7a4d34281a2587d9ae007eaa096c5ac63`. The source remained unchanged throughout the run. Documentation and generated evidence are excluded from that implementation/test fingerprint.

## Acceptance mapping

| Behavior / failure model | Executed evidence |
| --- | --- |
| Complete Community Planning/Open pagination, stable identities, all wards, safe refresh | `importer.test.js`, `import-persistence.test.js`, `import-refresh.test.js`, `import-edge.test.js`; complete live City API import in an isolated database |
| Multiple application addresses and conservative permit/address evidence | `import-refresh.test.js`, `repository.test.js`; importer source grouping and jobsite detail data |
| Toronto date windows, editable plans, owner restrictions, completed-stop preservation | `domain.test.js`, `admin-and-routing.test.js`, `repository.test.js`, `http.test.js`, browser route scenario |
| Concurrent creates/edits/visits and duplicate commands/photos | `concurrency.test.js`, `repository.test.js`, actual concurrent HTTP requests in `http.test.js` |
| Offline visits, photos, discovered jobsites/stops and quote drafts | Real Chromium phone viewport, service worker and IndexedDB in `field-sales-browser.mjs`; reload while disconnected and ordered reconnect assertions |
| Stale offline catalog prices/tax policies | Browser scenario retains rejected work, opens review, records an override, refreshes taxes and synchronizes the reviewed revision |
| Exact CAD amounts, invalid/overflow input and company totals | `domain.test.js`, `properties.test.js`, `quote-validation.test.js`; independent rational arithmetic oracle and five deliberately broken variants |
| Immutable history and combined/company PDFs | `repository.test.js`, `services.test.js`, HTTP PDF download and browser download; extracted PDF text, multipage output and fractional unit-rate assertions |
| Two remote estimates, same-ID updates, company closure, retries and conflicts | `posting.test.js`, `quote-lifecycle.test.js`, `quote-validation.test.js`; actual RESTlet execution with NetSuite SDK boundaries simulated in `restlet.test.js` |
| Active company catalogs, effective customer pricing and sales units | `catalog.test.js`, `restlet.test.js`; actual PostgreSQL rate/mapping tables and readonly transport boundaries |
| Feature gates and observable worker failures | `runtime.test.js`, `http.test.js`, `http-admin.test.js`; failure history, disabled gates and start/stop behavior |
| Additive migration and rollback | `migration.test.js`: recreate all 18 tables inside a rollback transaction; verify default-disabled settings, immutable quote trigger, and exact restoration of operator/quote counts and settings |
| Existing entrypoints and authentication | Actual application exported from `server.js`: Field Sales, Driver, Sales, MBT and Operator HTML routes; real Field Sales/admin/Sales sessions; unauthenticated denial |

## Final results

- Focused tests: **65 passed, 0 failed**.
- Coverage: **888/888 lines**, **90/90 functions**, **873/931 branches (93.77%)** across `src/field-sales/**` and the shared browser/server domain. Existing 95% line/function and 90% branch gates were retained.
- Mutation testing: **5/5 killed**, and **5/5 killed by the property suite alone**. Mutants remove rounding, omit tax, accept zero quantities or grant ordinary Sales access. Mutations run in temporary copies and never edit the workspace implementation.
- Suite health: the 19 focused test files also pass individually in a deterministic shuffled order (seed `20260918`).
- Browser: **5 scenarios passed**, no uncaught browser errors; desktop at 1536 pixels and phone at 390 pixels, real HTTP/PostgreSQL/IndexedDB/PDF paths. Expected validation responses are asserted, not treated as successful publication.
- Lint: passed using the repository's existing dispatch/driver JavaScript correctness rules. Strict shared-domain TypeScript checking passed.
- Actual application smoke: five entrypoints and three authenticated role checks passed. Workers were tested separately rather than starting unrelated production schedulers.
- Existing-app regression: **554 files executed; 23 failed assertions in 20 files**, all present in the baseline. The baseline contained 37 failed assertions in 30 files across 543 executed files. **Zero new failed assertions and zero new failing files.** The underlying existing suite exits 1; the baseline comparison passes. The repository as a whole is not described as having zero failures.
- Supply chain: the 19-package PDF dependency graph has **zero reported vulnerabilities and zero unresolved licenses**. The complete production dependency audit reports six affected existing packages: three moderate and three high (`@ericblade/quagga2`, `body-parser`, `express`, `ndarray-pixels`, `qs`, `sharp`). These were not updated as part of Field Sales. The new-file credential-pattern scan returned zero matches.

The [coverage report](../test-artifacts/field-sales/final/coverage.log), [browser results](../test-artifacts/field-sales/final/browser-results.json), [mutation results](../test-artifacts/field-sales/final/mutations.log), and [server smoke output](../test-artifacts/field-sales/final/server-smoke.log) retain the raw results.

## Corrections demonstrated during development

Observed failing tests exposed missing-coordinate handling, grouping of permits without an address, sign-permit substring matching, ward formatting, refreshed coordinates, effective-price timestamp handling, quote-total timing, stock/sales-unit mismatch, PDF rate precision and stale map coordinates after an address edit. Regression checks were added before the corresponding fixes where recorded. [Saved RED logs](../test-artifacts/field-sales/research/) retain representative failures.

Not every new assertion was authored before implementation. Some were added as regression protection after the implementation existed. The arithmetic/access mutants establish sensitivity for those tested invariants; they do not prove every assertion is independently sensitive. Initial PDF byte-count and migration-table-count fixture mistakes were corrected transparently in the append-only specification, replacing the former with stronger document-content checks.

The first full regression comparison examined failing files only. Comparing individual assertions exposed two obsolete inventory expectations inside already-failing files: the explicitly planned PDFKit dependency and the new admin navigation link. Those exact inventories were updated, Field Sales-only and secondary-role navigation cases were added, and the final comparator now checks assertion names within each file. Other expectations remain intact. The pre-correction report and logs are retained under `research/pre-contract-correction-*`.

The first license check rejected `tslib`'s permissive 0BSD license and `png-js`'s missing package metadata. Inspection of the installed license files verified Microsoft's 0BSD text and `png-js`'s MIT license. The scanner now recognizes 0BSD and records the packaged MIT license filename and hash when metadata is absent; unknown licenses still fail verification. The production PDF dependency graph includes packages already shared by other dependencies.

## Practical limits

- NetSuite record operations and Google road responses were simulated at their external boundaries. **No real NetSuite sandbox write or paid Google Maps call was performed.** Account-specific forms, subsidiary/customer membership, workflows, units and tax behavior require the activation checks in [the setup guide](field-sales.md).
- Line coverage above applies to the new server modules and shared domain, not every browser UI line or the SuiteScript SDK. The RESTlet source executes in a VM with SDK substitutes. Browser tests verify selected end-to-end flows; they are not physical-device or exhaustive UI coverage.
- Geography-based ordering is a suggestion; it does not establish a globally fastest road route. Road estimates remain unavailable when the shared Maps gateway is disabled or out of budget.
- Live data verification imported 5,724 planning-address records representing 2,154 applications, plus complete public permit/postal/address feeds. The [planning CSV](../test-artifacts/field-sales/research/toronto-open-community-planning-2026-09-18.csv) contains the planning snapshot and original links. Test counts are not production-state claims.
- Credential scanning checks known credential/private-key patterns in new files; it cannot prove the absence of every possible secret representation. The test environment was separately isolated from real credentials.
- No separate formatter or automated cyclomatic-complexity gate was introduced. Existing lint rules were retained; implementation organization was reviewed manually. Shared integration edits are exercised by server/authentication smoke and existing-suite contracts; the quoted line-coverage percentage does not include those entire legacy files.
- Capability changes are scoped to the four public City data feeds, the existing metered Maps gateway, and the dedicated NetSuite RESTlet through existing OAuth/queue infrastructure. Photos and quote history are persisted in PostgreSQL; PDF generation adds PDFKit. Subprocess/Docker execution belongs to verification tooling, not the Field Sales request handlers.

The original existing-suite baseline is stored in [baseline-failures.json](../test/field-sales/baseline-failures.json), with its output in [baseline-before.log](../test-artifacts/field-sales/research/baseline-before.log). The [final comparison](../test-artifacts/field-sales/final/baseline-comparison.json), [full regression output](../test-artifacts/field-sales/final/full-suite.log), [dependency inventory](../test-artifacts/field-sales/final/dependencies.json) and [production audit](../test-artifacts/field-sales/final/dependency-audit.log) preserve the exact remaining failures and advisory details.
