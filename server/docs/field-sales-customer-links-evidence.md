# Customer autocomplete and MBBS settings — September 22, 2026

Deployed to [Field Sales](https://test.mbbsoperation.com/field-sales/) at
**2026-09-22 03:01:48 UTC**. Record Visit and quote customer management now share
one autocomplete with **Add to site**, a plain contact list and **Remove**.
Remove unlinks only the current site. New-customer editing, visit notes/photos,
revisit dates and offline synchronization remain available.

The [specification](../test/field-sales/customer-links-spec.md) was not separately
approved (autonomous run). The user's implementation/deployment authorization
was reused. Old-coder Tier 1 was applied to the configuration-only MBBS update;
the Sales Order implementation, financial calculations and schemas were unchanged.

## Verification

All reported runs followed the last runtime edit.

| Check | Result |
| --- | --- |
| Complete Field Sales suite | 137 passed, 0 failed, 0 skipped |
| Customer browser checks | 8 scenarios passed; desktop, 390-pixel phone and offline |
| Existing quote/visit browser regression | 21 scenarios passed |
| ESLint | 0 errors, 0 warnings |
| Existing domain/pricing/identity/quote-drafts type checks | 0 errors |
| Live asset, health and authentication checks | 14 passed |
| Runtime deployment | Four files verified; service environment and other containers unchanged |
| Settings transaction rehearsal | Settings row and audit rows restored on rollback |
| MBBS profile/PDF | Saved values read back; one-page PDF header and CAD 50 + 6.50 = 56.50 verified; image inspected |

The customer browser checks cover duplicate names, selection versus submission,
duplicate submission, phone/email and keyboard search, excluded linked/archived
customers, preservation of other site links and historical visits, editable
representatives, unsaved form/photo preservation, offline queue ordering and the
quote's refreshed customer choices. The existing suite verifies customer-specific
NetSuite mapping and creation/recovery at Sales Order time. No NetSuite customer,
quote or Sales Order was created during this work.

Failures resolved: an old hidden suggestion remained in the DOM during the next
search; clearing it fixed keyboard selection. Repeated browser runs required
unique directory fixture names. The previous checkbox assertion was replaced with
the requested visible contact-list assertion, then scoped to the added contact.
An ESLint browser-global error was corrected to `window.innerWidth`. No numeric
assertions were weakened or tests skipped.

No new dependencies or application capabilities were added. No commits were made
in the shared dirty workspace. Mutation, property, changed-line coverage and
shuffled-suite runs were not repeated: the skill's Tier 1 scope was a verified
settings update, and this UI change reused the existing site-link command and
offline queue. Browser regression ran repeatedly; no flakiness remained. The
new autocomplete has no static typing claim beyond lint/browser execution.
Unrelated operator/dispatch suites were not rerun.

## MBBS saved values and sources

Settings revision advanced from **8 to 9**. Only the MBBS company profile changed;
MBT/MBR, quote validity, other settings and the server posting gate were preserved.
The update uses an explicit operational audit identity, not a staff account.

| Setting | Saved value | Verified source |
| --- | --- | --- |
| Company name | Mr Bin Building Supply LTD | Sample PDF and current subsidiary |
| Address | 3445 Kennedy Road, Toronto ON M1V 4Y3 | QuoteSample.pdf |
| Phone | (416) 912-9555 | QuoteSample.pdf |
| HST registration | 719366486 | Sample PDF and current subsidiary |
| Subsidiary / CAD currency | 1 / 1 | ESTB14950, September 21, 2026 |
| Default location | 3445, internal ID **1** | Latest quote and active location directory |
| Sales Order form | 156, Mr. Bin - Sales Order Front Desk | SOB120978 |
| New customer status | 13, CUSTOMER-Closed Won | Recent quote's customer status |
| Payment terms | 4, COD | Latest quote and Sales Order |
| Tax | Code 11, CA-S-ON, 13% | Latest quote item tax fields |
| Pickup / delivery methods | 1 / 2 | Latest quote / SOB120971 |

No default customer ID exists in company settings. The source quote's customer
was not copied into settings. Customer form ID remains blank because neither
SuiteQL nor the record API exposes the existing customer form. This missing value
was raised to the user. PDF terms remain blank because no general terms were
provided; the sample's job-specific memo is not a template term. Validity remains
30 days. Old saved quote revisions keep their saved templates.

The server's NetSuite write gate remains **off**, and the dedicated Field Sales
RESTlet URL remains absent. The UI's already-enabled Sales Order setting was
preserved. These settings do not establish real NetSuite posting readiness.

## Reproduce and recover

```bash
sudo -n bash server/tools/field-sales-customer-links-test.sh start
python3 server/tools/field-sales-customer-links-evidence.py inputs
sudo -n bash server/tools/field-sales-customer-links-test.sh exec bash tools/field-sales-customer-links-checks.sh
python3 server/tools/field-sales-customer-links-evidence.py report
sudo -n bash server/tools/field-sales-customer-links-test.sh stop
```

Pinned runner: `field-sales-check-2941306`; Node 20.20.2, PostgreSQL 18,
Playwright 1.62.1, ESLint 10.8.0, TypeScript 7.0.2. No packages were installed.
The disposable test containers were removed after completion.

Machine-readable [checks](../test-artifacts/field-sales/customer-links/customer-links-checks.json),
[settings verification](../test-artifacts/field-sales/customer-links/mbbs-settings-verified.json)
and [PDF verification](../test-artifacts/field-sales/customer-links/mbbs-settings-pdf.json)
are retained. The settings tool is `tools/field-sales-mbbs-settings.mjs`, executed
through stdin in the live app with `FIELD_SALES_SETTINGS_ACTION` set to `prepare`,
`rehearse`, `apply`, `verify` or `rollback`, and a private
`FIELD_SALES_SETTINGS_BACKUP` path. Rollback requires unchanged settings and
records its own audit event. The private backup is retained in
`test-artifacts/field-sales/customer-links-private/mbbs-settings-backup.json`.
PDF rendering uses `tools/field-sales-mbbs-settings-pdf.py` with the existing
PDFium installation. Deployment/rollback records remain privately under
`test-artifacts/field-sales/customer-links-deployment-20260922`.

Verified four-file source hash:
`b5db588ab029cac085a712e14f8233559fec05179e0cbeb1564f96aa92a66cb2`.
Image: `mbbs-operator-app:field-sales-customer-links-20260922-v1`.
Image ID: `sha256:e4ba56997135ace76f05c25ac6aa1704aa412b203deceae6c08c6c6ec8164abd`.
