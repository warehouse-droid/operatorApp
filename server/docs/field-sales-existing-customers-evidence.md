# Existing NetSuite customers only — September 22, 2026

Field Sales retains its independent customers, representatives, visits and quotes.
Customers and subsidiary memberships are created and maintained in NetSuite.
Confirming a quote requires explicit existing active CAD customer links for MBBS
and the shared MBT/MBR account. The confirmation popup provides autocomplete and
reuses previously saved links. The app and RESTlet cannot create customers or
customer-subsidiary relationships.

Spec approval: **not obtained (autonomous run)**. The user's instruction and
existing implementation/deployment authorization were applied. Old-coder Tier 3
covers customer assignment and Sales Order writes. The executable
[specification](../test/field-sales/existing-customers-spec.md) includes an
append-only adversarial addendum. This evidence establishes those scenarios;
the specification was not independently reviewed.

## Verification

All runtime results follow the last runtime edit. The sixth mutation and the
settings tool's lint check were added after the main run and executed separately.

| Check | Actual result |
| --- | --- |
| Complete Field Sales suite | 150 passed, 0 failed, 0 skipped |
| Shuffled complete Field Sales suite | 150 passed, 0 failed; seed 20260922 |
| New confirmation/settings browser checks | 5 scenarios passed |
| Existing combined quote/visit browser checks | 21 scenarios passed |
| Existing site customer browser checks | 8 scenarios passed |
| ESLint | 0 errors, 0 warnings in scoped files and cleanup tool |
| Existing domain/pricing/identity/quote-drafts type checks | 0 errors |
| Changed executable JavaScript lines | 93/93 covered, no unmeasured JS files |
| Manual mutations | 6/6 killed by scenario tests |
| Property-only mutation replay | 2/6 killed; properties address group completeness and remote identity/membership |
| New properties | 20 database examples for required account groups; 30 RESTlet rejection examples |
| Live settings transaction rehearsal | Settings and audit rows restored after rollback |
| Live order queue before cutover | Empty; no legacy accepted intent needs reconciliation |
| Live release verification | 16 checks passed; 12 file hashes matched, configuration and other services unchanged |
| Saved settings verification | Revision 9 → 10; only obsolete creation fields removed, all other settings preserved |

Machine-readable [checks](../test-artifacts/field-sales/existing-customers/existing-customers-checks.json),
[changed-line coverage](../test-artifacts/field-sales/existing-customers/changed-lines.json),
[mutations](../test-artifacts/field-sales/existing-customers/mutations.json) and
[settings rehearsal](../test-artifacts/field-sales/existing-customers/settings-rehearsal.json)
and [saved settings verification](../test-artifacts/field-sales/existing-customers/settings-verified.json)
are retained. Coverage combines real browser V8 and backend execution. Existing
modules have incomplete overall branch coverage; 93/93 is the changed executable
line measure, not a full branch-coverage claim. New picker branch measurement is
37/37; other files' measurements remain in the coverage artifact.

## Behavior and failure evidence

| Behavior / failure | Evidence |
| --- | --- |
| Local records and quotes need no NetSuite link or billing details | Unlinked local customer/quote test and real browser draft |
| Missing or invalid account rejects the whole confirmation | Database assertions retain zero intents, no confirmation and unchanged mappings |
| User chooses existing accounts only | Browser tests name/ID autocomplete, arbitrary-text rejection and required groups |
| Mapping and accepted quote are atomic | Three company intents use selected IDs; customer revision changes while quote snapshot stays immutable |
| Stale or concurrent edits cannot reassign an accepted customer | Stale revision cases and concurrent customer edit/confirmation: one succeeds, one conflicts |
| Worker never creates customers | Transport action assertions; replacing lookup with ensure is killed |
| Wrong persisted identity cannot reach NetSuite | Adversarial worker test and sixth mutation stop before any external call |
| Legacy unlinked jobs cannot create orders | Explicit missing accepted-link tests, including a previously persisted customer ID |
| Remote customer must be active, match currency/ID and cover subsidiaries | Actual SuiteScript code runs against the simulated NetSuite record/search boundary; 30 property examples reject with zero writes |
| Direct creation action cannot bypass the app | RESTlet rejects customer.ensure; creation mutation is killed |
| Retry and identity recovery remain intact | Existing lost-response/recovery and independent company order tests |
| Quote totals, PDF and offline work stay intact | Full suite plus 21 real quote/visit browser scenarios, including three-page PDF and queued drafts |
| Existing site customer controls remain intact | 8 browser scenarios cover duplicate names, keyboard search, site-only removal, visit photos and offline ordering |
| Customer creation settings disappear | Settings browser and readiness checks; outgoing payload assertions; exact before/after cleanup verification |

Desktop and 390-pixel phone screenshots were captured; the confirmation popup
was visually inspected. Real browser tests use the app and disposable PostgreSQL,
with external writes disabled. They do not substitute a mock for the app API.

## Failures resolved

The original six backend cases and three RESTlet cases failed before runtime
implementation. A later adversarial case reproduced a PostgreSQL bigint overflow
for an oversized customer ID; safe integer validation now returns a normal input
error without partial writes. The new test passed after that fix.

Existing fixtures explicitly created NetSuite customers under the superseded
policy. They now seed existing mirror accounts and customer/relationship records,
while retaining their independent-order, totals and recovery assertions. The
RESTlet fixture extraction first passed all original tests before runtime edits.
A fixture lookup was removed from a production write-gate test so the test reaches
the intended order assertion. The admin browser uses its own authentication
context; the initial shared context accidentally retained the field rep token.
Lint's shadowing and bracing findings were corrected. No numeric assertions were
weakened and no cases were skipped.

## Reproduce

```bash
sudo -n bash server/tools/field-sales-existing-customers-test.sh start
python3 server/tools/field-sales-existing-customers-evidence.py inputs
sudo -n bash server/tools/field-sales-existing-customers-test.sh exec bash tools/field-sales-existing-customers-checks.sh
python3 server/tools/field-sales-existing-customers-evidence.py report
sudo -n bash server/tools/field-sales-existing-customers-test.sh stop
```

The pinned `field-sales-check-2941306` runner uses Node 20.20.2, PostgreSQL 18,
TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, Playwright 1.62.1, fast-check 4.9.0,
pg 8.21.0, PDFKit 0.20.2 and sharp 0.35.3. No dependencies were added, so no
dependency audit was needed. Changed sources were scanned for credential patterns.
No new application network, filesystem or subprocess capability was added.
No separate performance budget was requested. No commit was made in the shared
dirty workspace. Unrelated operator/dispatch suites were not rerun or claimed
to pass; historical wider-repository evidence records 37 unrelated failures.
Disposable test containers and their internal network were removed on completion.

Verified 12-file source tree:
`c8ce2ff9235abd924d16c91b7bb66173b9ecf53652510a6633734edecccbea1d`.

## Deployment and operational limits

Release: `mbbs-operator-app:field-sales-existing-customers-20260922-v1`.
Deployed to [Field Sales](https://test.mbbsoperation.com/field-sales/) at
**2026-09-22 03:48:52 UTC**. All **16 live health, asset and authentication checks**
passed. All 12 runtime files matched their verified hashes; application
configuration and other service containers were unchanged. Image ID:
`sha256:68295a9d3ac0df8fdda90e412d6f8b10f171e58df66a9b430e3e01667fdf4175`.
The scoped image replaces only 12 verified files over the active image, without
schema changes. The RESTlet source is included in the app image; this does not
deploy it into the NetSuite account.

The dedicated NetSuite RESTlet URL is still absent and the server posting gate
remains off. No live customer, relationship, quote or Sales Order was created.
Account-specific compatibility is not established by the sandbox boundary tests.
The NetSuite integration must deploy RESTlet 2.1 with existing-customer mode and
configure its connection before posting can be enabled. Customer search reads
the synced NetSuite directory; new accounts must first be available there.

Saved settings cleanup removes only `customerFormId` and `customerStatusId`.
It completed at settings revision **10**, with exact before/after verification.
It uses a revision-guarded transaction and an explicit operational audit identity,
not a staff identity. Verified MBBS details and location internal ID 1 (3445),
quote validity, MBT/MBR profiles and all posting flags are preserved. The private
before/after backup is retained at
`test-artifacts/field-sales/existing-customers-private/settings-backup.json`.
The tool `tools/field-sales-existing-customers-settings.mjs` runs through stdin
inside the app with `FIELD_SALES_SETTINGS_ACTION` and a private
`FIELD_SALES_SETTINGS_BACKUP` path. Supported actions are prepare, rehearse,
apply, verify and rollback. Rollback requires no intervening settings change
and records its own audit event. App image rollback and deployment records are
retained under `test-artifacts/field-sales/existing-customers-deployment-20260922`.
