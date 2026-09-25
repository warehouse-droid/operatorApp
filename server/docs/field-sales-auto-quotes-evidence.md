# Automatic company quotes — September 22, 2026

The quote editor now accepts items from all three companies and saves one
independent quote per represented company. Users do not select an issuer.
Bill To, Ship To and Expected Close inputs are removed. New PDFs show customer
and jobsite information instead of address blocks. Quote date is today's Toronto
date at save; expiry comes from Settings, defaulting to 30 days.

The [executable specification](../test/field-sales/auto-quotes-spec.md) follows
the user's requests. Spec approval: not obtained (autonomous run); the detailed
test contract was derived without separate human review. The old-coder Tier 3
workflow was used for money, offline durability and concurrent saves.

## Final checks

| Layer | Result |
| --- | --- |
| Complete Field Sales suite | 128 passed, 0 failed, 0 skipped |
| Shuffled suite | 128 passed, 0 failed, 0 skipped |
| Chromium desktop, phone and offline workflows | 17 passed |
| Changed executable lines, merged Node/browser coverage | 118/118; no unmeasured JavaScript files |
| Deliberate mutations | 4/4 killed; properties alone killed 2/4 |
| ESLint | Passed |
| TypeScript for domain, pricing, identity and quote grouping/dates | Passed |
| Source hashes and basic private-key/AWS-key pattern scan | Passed |

All results were collected after the final runtime edit. The verified source
manifest covers 40 files; 11 changed/new files form the release. Its aggregate
SHA-256 is `de01839dc32eef3a121645d25d28cd4b6219c108545d4cc2555048ba243292fd`.
See [machine-readable checks](../test-artifacts/field-sales/auto-quotes/auto-quotes-checks.json)
for individual hashes, browser cases, tool versions and mutation results.
Branch percentages are recorded separately and are not uniformly 100%.

## Contract mapping and failure model

| Specification | Evidence |
| --- | --- |
| All-company item search without issuer selection | Browser absence checks, all-company offline suggestions, three-company composer and grouped item totals |
| Correct separation and retained history | Property tests preserve every item exactly once and stable company IDs; database tests verify separate numbers, amounts and revisions |
| Atomic and retryable saves | Concurrent same-command database tests; invalid/confirmed member rollback; browser mixed-tax rejection and explicit recovery; later offline edits survive group acknowledgement |
| Automatic date and configured expiry | Properties cover default 30 days, 0–3650 days, year/leap transitions; save ignores supplied date/expiry and uses server Toronto date and saved settings |
| Simple quote form/PDF with immutable history | Generated PDF assertions remove address/expected-close labels and retain customer/site/date/totals/memo; earlier sample/history/PDF tests remain passing |
| Customer-sourced NetSuite billing | Intent test sets the customer-billing flag; actual RESTlet code against simulated SuiteScript records verifies it does not write the billing override |
| Existing protections and offline compatibility | Full Field Sales regressions, authorization/confirmation/evidence tests, service-worker cache tests, offline reload and retained recovery cases |

The four mutations deliberately leak items across companies, add an expiry day,
save only the first company, and override NetSuite customer billing. The grouping
and date properties kill the first two. The batch and RESTlet integration tests
kill the remaining two; properties alone do not verify those boundaries.

The adversarial pass includes null/oversized/inconsistent groups, duplicate
identities, a different jobsite, invalid quantities, invalid validity durations,
stale tax, confirmed members and simultaneous retries. No new database schema or
runtime dependency is required. The existing licensed PDF fonts remain unchanged.
New helpers separate grouping, dates and transactional saving; the established
editor rendering structure is retained.

## Failures found and resolved

The initial tests failed on the missing group-save command, automatic grouping
and dates, old PDF address blocks, and the RESTlet billing override. The hostile
group test also exposed a null-entry TypeError; malformed groups now receive a
validation response without any quote writes.

Browser execution found a customer-selection redraw could discard an item search;
search is disabled until that redraw completes. Reloading offline also showed
that a browser can miss the reconnect event. Transient synchronization failures
now schedule a short retry while retaining durable commands.

The full browser regression then found an older list response could hide an
acknowledged save. List merging now remembers pending records at request start
and retains their newer local revisions. The customer-type scenario also waits
for the newly added type's row before submitting a separate archive action; its
assertions were retained.

The prior manual-expiry rejection test described superseded behavior. It now
asserts that supplied dates cannot override today plus the configured duration.
The earlier company-selector and company-restricted autocomplete assertions were
replaced by the explicitly requested automatic behavior. Historical PDF assertions
were retained unchanged.

The generated [company PDF](../test-artifacts/field-sales/auto-quotes/automatic-quote.pdf)
and [phone screenshot](../test-artifacts/field-sales/auto-quotes/automatic-quotes-mobile.png)
were visually inspected. The PDF fits one page and retains signatures and barcode.

## Reproduce

Run from the repository root, starting the disposable runner once:

```sh
bash server/tools/field-sales-auto-quotes-test.sh start
python3 server/tools/field-sales-auto-quotes-evidence.py inputs
bash server/tools/field-sales-auto-quotes-test.sh exec bash tools/field-sales-auto-quotes-checks.sh
python3 server/tools/field-sales-auto-quotes-evidence.py report
```

The extra browser stability run also passed all 17 scenarios after the final runtime edit. It uses a separate artifact directory:

```sh
bash server/tools/field-sales-auto-quotes-test.sh exec env FIELD_SALES_ARTIFACT_DIR=/artifacts/repeat node tools/field-sales-auto-quotes-browser.mjs
```

Tools: Node 20.20.2, PostgreSQL 18, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
Playwright 1.62.1, fast-check 4.9.0, pg 8.21.0, PDFKit 0.20.2, sharp 0.35.3.
The runner's internal Docker network and disposable database prevent production
or NetSuite writes. No commits or resets were made in the dirty shared workspace.

## Limits and deployment

Browser checks use Chromium, including a 390-pixel viewport and emulated offline
network/native-UUID absence. Physical phones and Safari/WebKit were not tested.
The existing pg parallel-query deprecation warning remains. Unrelated operator
and dispatch suites were not rerun; this report covers Field Sales.

NetSuite's real sandbox remains unvalidated because the dedicated RESTlet URL is
absent. Submission stays disabled. The updated RESTlet source is included for
the later account setup; no external RESTlet deployment or real customer/order
creation is claimed. Actual account-sourced billing must be verified there.

The app release overlays only the 11 verified Field Sales files on the active
image, with no schema, environment, account or dependency-service changes.
The prior image is retained for rollback.

Deployment completed at **2026-09-22T01:06:30.935967+00:00**. Image `mbbs-operator-app:field-sales-auto-quotes-20260922-v1`
(`sha256:84b1f1b2f96fb1b283baac459e48e34db05e04c13d14871b809839d3efd1121e`) passed 18 live checks and matched all
11 runtime hashes. Configuration and other services were unchanged.
The subsequent read-only smoke check verified automatic grouping, generated all
three company PDFs, and passed 12 additional authorization checks.
No test quotes or customers were inserted. NetSuite submission remains disabled.

See [deployment result](../test-artifacts/field-sales/auto-quotes-deployment-20260922/deployment-result.json)
and [live workflow checks](../test-artifacts/field-sales/auto-quotes-deployment-20260922/live-workflow-checks.json).
Rollback image: `mbbs-operator-app:rollback-field-sales-auto-quotes-20260922-v1`.
