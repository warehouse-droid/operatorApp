# Combined Field Sales quote evidence — September 22, 2026

Implemented and deployed one local quote, one PDF with company sections, and a
one-to-many relationship to NetSuite Sales Orders. The existing MBBS/MBR batch
is now **FS-000002**, with a verified **two-page PDF**. Original document numbers
FS-MBBS-000002 and FS-MBR-000003 and their immutable revisions remain available.

Spec approval: **not obtained (autonomous run)**. Implementation and deployment
were authorized in the conversation. This is Tier 3 verification under the
[executable specification](../test/field-sales/combined-quotes-spec.md); the
specification was not independently reviewed, so the evidence establishes the
listed behavior, not exhaustive correctness.

## Final verification

All results below come from the final run after the last runtime source edit.

| Layer | Actual result |
| --- | --- |
| Complete Field Sales suite | **137 passed, 0 failed** |
| Shuffled Field Sales suite | **137 passed, 0 failed**, seed 20260921 |
| Real browser | **21 scenarios passed**, desktop and 390-pixel phone layout |
| ESLint | **0 errors, 0 warnings** in scoped files |
| Static types | **0 errors** in domain, pricing, identity and quote-drafts modules |
| Changed executable JavaScript lines | **124/124 covered**, no unmeasured JS files |
| Manual mutations | **5/5 killed** by the scenario suite |
| Property-only mutation replay | **1/5 killed**; conservation properties cover money/items, not acceptance, PDF rendering or migration policy |
| Property tests | Existing properties plus **20 randomized database examples** for combined quote conservation/removal |
| Real PDF | Three company pages extracted independently and visually inspected; company isolation, saved templates, CJK memo and total checked |
| Live migration rehearsal | Grouped the requested pair inside a transaction; rollback restored quote data and schema |
| Backup | Validated custom-format dump of Field Sales tables and migration ledger, **63,851,127 bytes** |
| Deployment | **12 files** over the running image; **16 live health/asset/auth checks** passed |
| Live database/PDF check | Read-only verification: one parent list row at quote and jobsite, preserved historical PDFs, **2-page combined PDF**, **6 additional authentication checks** |

Machine-readable results: [verification](../test-artifacts/field-sales/combined-quotes/combined-quotes-checks.json),
[live checks](../test-artifacts/field-sales/combined-quotes/live.json),
[changed-line coverage](../test-artifacts/field-sales/combined-quotes/changed-lines.json),
[mutations](../test-artifacts/field-sales/combined-quotes/mutations.json).
Branch measurements are retained in the coverage report; no claim of complete
branch coverage is made. SQL and CSS are verified through migration and browser
execution, not JavaScript line instrumentation.

## Specification mapping

| Behavior / failure mode | Executed evidence |
| --- | --- |
| One quote and consistent totals | `combined-quotes.test.js`: one mixed quote, conservation property; `auto-quotes.test.js`: atomic save/date/validity |
| One PDF, separate company pages | Combined PDF test checks each page's items, original document references and overall total; existing 55-item PDF test checks continuation; browser downloads actual PDF |
| Concurrent save/acceptance and immutable revisions | Concurrent mixed save/confirmation test, stale/hostile input test, existing command/confirmation tests |
| One parent, multiple company order intents | Three-intent test checks identical parent ID, isolated lines, totals and unique stable external IDs |
| Atomic preflight and evidence ownership | Combined preflight/evidence test plus existing quote-evidence ownership/revision tests |
| Shared customer and independent order recovery | Three-worker test creates two customer accounts and three orders; lost MBR response recovers without duplicate creation; retry changes only the selected order |
| Safe migration/history | Receipt migration, unique migrated line IDs, unsafe candidate tests for accepted/edited/different-site/different-memo batches, idempotent rerun; live rollback rehearsal |
| Old links and obsolete offline work | Browser follows both original histories, converts an old batch into the same parent, and applies a stale child edit without removing the other company's items |
| Offline reload/replay and stale taxes | Browser queues two revisions offline, reloads, reconnects, reviews stale tax expectations and preserves drafts/recovery copies |
| Historical content cannot look accepted | Browser verifies an older revision has no later confirmation/order panel and cannot be edited |
| Permissions and original modules | Complete Field Sales HTTP/auth/customer/visiting/import/map/route suites; live protected endpoints remain 401 without authentication |

## Failures observed and resolved

The first acceptance run failed all **8** new cases on the prior independent
quote implementation. The adversarial run additionally exposed malformed null
items, colliding legacy line IDs, and differently annotated batch members; all
are handled without partial writes. Browser execution caught the totals panel
covering the confirmation button, and the history check caught an older revision
showing a later acceptance panel. Both now pass.

Test fixture corrections were explicit: command results are compared as JSON
(the HTTP contract serializes dates); PDF page assertions use the established
MBBS/MBR/MBT ordering; the browser completes its simulated order boundary before
relinking a customer, waits for save acknowledgement, and navigates before
opening a queued legacy draft. Old independent-quote assertions were superseded
by the user-approved combined-quote behavior; atomicity/recovery assertions were
retained. There are no skipped tests or weakened numeric tolerances.

## Reproduce

The isolated runner uses the existing pinned `field-sales-check-2941306` image
and disposable PostgreSQL 18, with all external execution gates disabled.
Docker access is required. From the repository root:

```bash
sudo -n bash server/tools/field-sales-combined-quotes-test.sh start
sudo -n python3 server/tools/field-sales-combined-quotes-evidence.py inputs
sudo -n bash server/tools/field-sales-combined-quotes-test.sh exec bash tools/field-sales-combined-quotes-checks.sh
sudo -n python3 server/tools/field-sales-combined-quotes-evidence.py report
sudo -n bash server/tools/field-sales-combined-quotes-test.sh stop
```

The checks entry point runs lint, types, the complete suite, the real browser,
merged backend/browser coverage, isolated-copy mutations, property-only mutation
replays and shuffled tests. PDF visual review used the existing PDFium
installation with `server/tools/field-sales-combined-quotes-render.py`.
Versions: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
Playwright 1.62.1, fast-check 4.9.0, pg 8.21.0, PDFKit 0.20.2, sharp 0.35.3.
No packages were added, so no dependency audit was needed. Changed runtime
sources were scanned for credential patterns. No new external network,
subprocess or filesystem capability was introduced to the application. Existing
PDF/database mechanisms were reused; the company renderer was separated from
PDF orchestration. No new performance budget was specified.

Verified source tree (39 measured runtime/migration inputs):
`12d3bb6b14c37dc620bbd3e6262a5e891b1362fa8647aa1efe01bd589186d56d`.
No commit was created in the shared dirty workspace. Historical wider-repository
results include 37 pre-existing failures, as recorded in the original release;
unrelated operator/dispatch suites were not rerun or claimed to pass here.

## Deployment and limits

Deployed at **2026-09-22 01:44:47 UTC** to
[Field Sales](https://test.mbbsoperation.com/field-sales/#quotes).
Image: `mbbs-operator-app:field-sales-combined-quotes-20260922-v1`;
image ID `sha256:db98a81f48df9068a43df1e2b80e1e84d89b366da08264d112f5167d1cb61692`.
Applied only `214_field_sales_combined_quotes.sql`. App configuration and other
services were verified unchanged. Scoped deployment, backup and rollback records
are retained privately under `test-artifacts/field-sales/combined-quotes-deployment-20260922`.

NetSuite's dedicated RESTlet URL is still absent and both live write gates remain
off. The real publisher was tested against a simulated network boundary; no real
customer or Sales Order was created, and account-specific NetSuite compatibility
is not established by these tests. Existing accepted or independently changed
company quotes are retained separately rather than guessed into a batch. If an
old failed batch contains multiple independently saved quotes, review creates a
new combined draft and retains those originals for recovery.
