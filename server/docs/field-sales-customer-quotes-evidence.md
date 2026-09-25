# Field Sales customer quotes: verification and release

The user-approved plan was implemented on 2026-09-21. The executable acceptance
contract is [customer-quotes-spec.md](../test/field-sales/customer-quotes-spec.md).
Its detailed cases were derived from that plan; they were not separately reviewed
by the user. The old-coder Tier 3 workflow was used because this change handles
money, customer identity, offline records and concurrent external writes.

## Final verification

The final source freeze covers 39 runtime files. The release overlays 26 changed
or new files on the already deployed UUID hotfix. Per-file SHA-256 values and tool
versions are in [customer-checks.json](../test-artifacts/field-sales/customer-quotes/customer-checks.json).
No unrelated workspace changes are included and no commits or resets were made.

| Check | Result |
| --- | --- |
| Complete Field Sales Node suite | 121 passed, 0 failed, 0 skipped |
| Same suite with shuffled file order | 121 passed, 0 failed, 0 skipped |
| Chromium desktop, phone and offline scenarios | 14 passed |
| Changed executable lines, merged Node/browser V8 coverage | 795/795 covered; no unmeasured JavaScript files |
| Five deliberate behavioral mutations | 5/5 killed; properties alone killed 4/5 |
| ESLint | Passed |
| TypeScript checks of shared domain, pricing and UUID helper | Passed |
| Source freeze and basic private-key/AWS-key pattern scan | Passed |

Coverage collection does not enforce backend-only percentages because browser
code needs browser execution and retired estimate functions remain for history.
The subsequent merged report enforces 100% coverage of changed executable lines.
Branch coverage is reported per file in
[changed-lines.json](../test-artifacts/field-sales/customer-quotes/changed-lines.json);
it is not 100% for every file. Mutation coverage is deliberately small and targets
UUID validity, customer grouping, remote totals, accepted revision identity and
the confirmed-quote edit lock. The last mutant requires the database integration
test; properties alone do not kill it.

Verified tools: Node 20.20.2, PostgreSQL 18, TypeScript 7.0.2, ESLint 10.8.0,
c8 12.0.0, Playwright 1.62.1, fast-check 4.9.0, pg 8.21.0, PDFKit 0.20.2 and
sharp 0.35.3. The isolated runner uses an internal Docker network and a disposable
database. No new npm runtime dependency was added. Embedded Noto CJK fonts include
their SIL Open Font License and source hashes.

## Acceptance evidence

| Contract | Evidence |
| --- | --- |
| 1. UUID fallback | `uuid.test.js`, property tests and browser quote creation with native `randomUUID` removed |
| 2. Customer directory | `customer-quotes.test.js`: multiple types/representatives/sites, revisions, archive and explicit NetSuite links; browser create/edit/archive/link flows |
| 3. Visit contacts and offline work | Snapshot/ownership tests plus browser inline customer creation, retained note/photo/revisit, two contacts and ordered reconnect synchronization |
| 4. One company and exact pricing | Company quote validation, trade lifecycle/pricing and fixed-point properties; browser company autocomplete, line summaries and stale-tax review |
| 5. Revisions and PDF | `company-pdf.test.js`: actual PDF text, exact CAD totals, Chinese memo, multipage headers and visibility; historical template/tax snapshots and phone layout |
| 6. Confirmation and copy | Atomic revision lock and one order intent, stale/empty rejection, evidence ownership/size/replay tests; browser confirmation, attachment download, lock and editable copy |
| 7. Customer identity | MBBS versus shared MBT/MBR grouping properties; concurrent shared-customer tests and RESTlet subsidiary relationship contracts |
| 8. Durable external writes | Lost-response recovery, concurrent orders, unavailable catalog after remote commit, retained remote ID on mismatch, and RESTlet external-edit detection |
| 9. Authorization | HTTP role checks for directory, quotes, evidence, admin preview/integration; actor-bound command receipts; no account or credential changes |
| 10. Compatibility | Migration preservation, legacy history, explicit offline mixed-draft split, recovery copies, accepted-revision conflict display and service-worker upgrade without clearing IndexedDB |

The sample PDF is
[company-quote.pdf](../test-artifacts/field-sales/customer-quotes/company-quote.pdf).
Its rendered page and desktop/phone screenshots were visually inspected. The PDF
uses the supplied `~/QuoteSample.pdf` layout, without packing columns. The
sample arithmetic is 4,828.70 subtotal + 627.73 HST = 5,456.43 CAD. Long quotes
retain the final item and repeat table headings. Real barcode scanner testing was
not performed.

Red tests exposed the missing native UUID API and superseded estimate contracts.
Behavioral browser checks also exposed asynchronous rendering issues that could
lose a selected visit contact, miss a revisit shortcut, reopen a closed editor,
or overwrite a newly opened quote with a delayed page response. Those cases now
pass. Existing mixed-company estimate publication assertions were replaced with
the user-approved local quote/confirmed Sales Order contract; standalone legacy
estimate tests and historical records remain.

## Reproduce

Run from the repository root; start the isolated runner only once:

```sh
bash server/tools/field-sales-customer-test.sh start
python3 server/tools/field-sales-customer-evidence.py inputs
bash server/tools/field-sales-customer-test.sh exec bash tools/field-sales-customer-checks.sh
python3 server/tools/field-sales-customer-evidence.py report
```

The gauntlet runs lint, scoped types, the complete Field Sales suite, browser
checks, merged changed-line coverage, mutations and shuffled tests. Logs and
machine-readable results are under `server/test-artifacts/field-sales/customer-quotes`.
The existing shared database helper emits a pg deprecation warning about parallel
queries on one client; it does not fail these checks.

## Deployment and external limits

The UUID hotfix was deployed first at 2026-09-21T21:24:14Z and verified with 20 live
checks. It uses secure `getRandomValues` when native `randomUUID` is missing.
George's account, permissions and credentials were not changed.

The customer release uses a scoped overlay on the active app image, an additive
213 migration, a private backup of all Field Sales tables and the migration ledger,
an idle cutover check, and app-only replacement. The backup intentionally excludes
unrelated application tables. Rollback restores the previous application image
while retaining the additive schema and data. Runtime file hashes, public assets,
health, unauthorized API responses, service configuration and other containers
are checked after replacement.

Deployment completed at **2026-09-21T22:48:40Z**:

- Image: `mbbs-operator-app:field-sales-customer-20260921-v1`.
- Image SHA-256: `7af3c575a0536630fc2464df68ef020debe627fe1d8215d22a5f511fd39e4274`.
- All 26 packaged runtime files matched their verified hashes; 26 live deployment
  checks passed. Service configuration and other services were unchanged.
- Migration 213 applied once. The validated backup contains 63,797,278 bytes;
  its hash and table of contents are retained in the private release artifacts.
- Additional live checks at 22:49:47Z passed: new customer/type/quote queries in a
  read-only transaction, generated PDFs for MBBS/MBT/MBR using deployed fonts, and
  12 unauthenticated endpoint checks. No test customers or quotes were inserted.

Machine-readable evidence:
[deployment result](../test-artifacts/field-sales/customer-deployment-20260921/deployment-result.json),
[live workflow checks](../test-artifacts/field-sales/customer-deployment-20260921/live-workflow-checks.json),
and [backup metadata](../test-artifacts/field-sales/customer-deployment-20260921/backup.json).
The prior UUID-hotfix image is retained as
`mbbs-operator-app:rollback-field-sales-customer-20260921-v1`.

NetSuite RESTlet version 2 is implemented and tested against simulated SuiteScript
APIs, but has not been deployed or validated in the actual NetSuite sandbox.
`FIELD_SALES_RESTLET_URL` is absent; server and Settings posting gates remain off.
No real NetSuite customer, estimate or Sales Order was created by this work.
The RESTlet, account-specific forms/defaults/custom fields and sandbox acceptance
tests are required before enabling submission; see [activation](field-sales.md#activation).
Company legal header details remain editable settings and were not guessed.

Browser verification used Chromium. Missing native UUID support was emulated;
Safari/WebKit and physical phones were not run. Unrelated operator/dispatch suites
were not rerun; their historical baseline failures are documented separately.
The passing results above apply to the Field Sales scope only.
