# Field Sales Trade release evidence

Deployed 2026-09-19T01:53:08.724848+00:00 to https://test.mbbsoperation.com/field-sales/.
The release adds inline item autocomplete, MBBS TRADE-A, MBR/MBT TRADE,
quantity breaks, and MBR quote totals/PDFs and estimate split support.

Tier 3. Spec approval: **not obtained (autonomous run)**. The user authorized the
feature and deployment; the detailed executable spec was authored autonomously.
These checks provide layered evidence, not independent human approval of the spec.

- Source fingerprint: `cedaca1fccd8578619d7bb7197229bbb9e54c94f81f5784f345359cdf3a9ac74`.
- Image: `mbbs-operator-app:field-sales-trade-20260919-v5`.
- Image ID: `sha256:a558523ae5cb91bf4c556c63ef095a30ffaa54d8860e37e0845611df0fea0bbb`.
- 15 scoped runtime files; application configuration and other services preserved.
- Database migration 211 applied after a validated 371,136,436-byte backup.
- Catalog refreshed: 1,385 MBBS / 160 MBR / 116 MBT items (1,661 total).
- Available required-tier prices: 1,265 MBBS / 2 MBR / 7 MBT. Missing rates require
  an agreed price and reason. No base/local-rate substitution.
- NetSuite transaction posting remains disabled. The updated RESTlet source is
  included, but has not been deployed remotely; no real estimates were created.

Reproduce checks with `bash server/tools/field-sales-trade-test.sh`. The retained
`field-sales-check-2941306` tool image used Node 20.20.2, Playwright 1.62.1, c8
12.0.0, ESLint 10.8.0, fast-check 4.9.0 and TypeScript 7.0.2. No dependencies were
installed or changed for this task; the existing transitive coverage merge helper
combines browser counters across reloads. No git commits were made.

| Check | Final result |
|---|---|
| Full Field Sales suite | 92 passed, 0 failed, 0 skipped |
| Browser workflows | 25 passed across autocomplete, visits, maps, recency and offline quotes |
| Strict shared-money/pricing types and scoped lint | Passed |
| New-function complexity limit 25 | Passed |
| Existing server/shared-code coverage gate | 995/995 lines; 104/104 functions; 978/1,038 branches (94.21%) |
| Measured changed executable lines | 199/199; includes quote/autocomplete changes |
| Browser quote/autocomplete diagnostic coverage | 158/169 lines (93.49%); 126/182 branches (69.23%) |
| Deliberate fault injection | 9/9 killed; property-only rerun killed 4/9 |
| Shuffled suite order | All 25 test files passed; seed 20260919 |
| Exact release image | Boot, authentication, three-company quotes/PDFs and missing-config refusal passed |
| Live deployment checks | 22 passed; public assets match packaged hashes; anonymous APIs denied |

The property-only survivors cover database validation, serialization, migrations,
empty refreshes and ambiguous reader data. Those are caught by integration and
reader contract tests, not by the numeric properties. Browser coverage does not
claim full coverage of unchanged customer/reconciliation screens. App shell,
settings, service-worker and SuiteScript source line coverage is not measured;
settings/mobile/offline browser tests, real-image startup and actual RESTlet VM
contract tests cover their behavior. Remote financial posting was not exercised.
The unrelated wider operations/MBT suite was not rerun for this module-only
release; its pre-existing baseline failures are not represented as passing.
Dependency audit was not repeated because no dependency set changed. Runtime
diff inspection found no new credentials. No arbitrary customer/financial data
was created in the deployed database during verification.

| Spec behavior | Evidence |
|---|---|
| Autocomplete, company filter, keyboard, stale search, phone/offline | `field-sales-trade-browser.mjs` |
| Delayed price cannot alter another quote | Browser regression first failed with 1 unexpected line, then passed |
| Exact tiers, CAD/company/unit metadata, null thresholds, legacy cache | T1/T2/T8/T9/T11 and independent threshold property |
| Complete catalog replacement, missing prices, settings races | P1/P2/T10 |
| Three-company money and immutable revisions | Rational-oracle property, T3/T5 and existing quote tests |
| Three distinct RESTlet preflights, recovery and gates | T4, NS1–NS4 and posting/reconciliation tests |
| Migration rollback and concurrent refresh protection | T6/T7 |
| Existing visits, routes, maps and conflicts | Full suite and unchanged browser assertions |

The implementation was corrected through failing checks: null NetSuite quantity
thresholds, stale offline catalog suggestions, and the delayed-price navigation
race each have retained failing evidence. Harness issues were also fixed without
weakening assertions: the RESTlet file mount, migration-sensitive fixture
revision, catalog fixture isolation, asynchronous item selection waits, desktop
settings navigation, and coverage collection before browser context destruction.
The original server coverage thresholds remain in force; new UI measurement is
separate, with execution required for measured changed lines.

Raw evidence is in `server/test-artifacts/field-sales/trade/`, failing checks in
`trade-red/` and `trade-race-red/`, and deployment/backup metadata in
`trade-deployment-20260919/`. The executable spec is
[trade-spec.md](../test/field-sales/trade-spec.md).
