# MBT planning and draft quote repairs — evidence

Deployed `mbbs-operator-app:mbt-planning-repairs-20261026`. The live application is
healthy, all ten deployed file hashes match the tested candidate, and the served
search, Front Desk and Dispatch scripts match those files. Application
configuration and other production services were preserved. No schema migration.

Tier 3 applies to quote amounts and concurrent edits. Spec approval: not obtained
(autonomous run); acceptance criteria were inferred from the user's requests.
The user explicitly authorized the 20YD and subsequent 40YD payload settings.
This evidence verifies those criteria; it is not independent approval of the spec.

Reproduce the scoped checks from the repository root:

```sh
bash docker/run-mbt-planning-repairs-checks.sh
```

The runner uses the retained release candidate and live baseline, bounded
`mbbs-tests.slice` containers, and a fresh disposable database per test file.
The final fresh run completed at **2026-10-26T20:18:44.972Z**. Exact source hashes,
tool versions and layer results are in
`deployments/mbt-planning-repairs-20261026/validation.json` (relative to `server`).

| Layer | Final result |
| --- | --- |
| Scoped unit, integration, browser, concurrency and property suites | 128/128 passed across 33 files; no failures, skips, cancellations or source drift |
| Syntax, ESLint/complexity, strict TypeScript | 7 JavaScript files checked; 0 new lint/type errors; 0 baseline type errors |
| Changed-line coverage, Node plus source-verified browser V8 | 165/165 measured lines; 99/100 changed branches |
| Manual mutation | 4/4 faults caught by integration/property tests; the same 4/4 caught by properties alone |
| Suite health | 9/9 tests passed when the six changed-feature suites ran in reverse order |
| Secrets/capability review | 0 diff secret findings; no new dependencies or external service capabilities |

| Acceptance criterion | Executable evidence under `test/mbt` |
| --- | --- |
| All Planning and ordinary Dispatch tabs survive repeated switches | `integration/bin-transport-browser.test.js`, `integration/bin-planning-browser.test.js` |
| Search 205 bins, hide unavailable choices, retain selection and support keyboard use | `integration/bin-asset-search-browser.test.js`; transport, selection and order-workflow browser suites exercise actual route dialogs |
| Garbage deposit from a separate item rate card survives quote creation, issue, acceptance and conversion | `integration/frontdesk-item-deposit-quote.test.js` |
| Draft identity, recalculation, revision, audit, cancelled prior charges and conversion | `integration/frontdesk-quote-edit.test.js` |
| Stale/cross-customer/unauthorized edits, rollback and concurrent edit/issue | `integration/frontdesk-quote-edit.test.js`, `integration/frontdesk-adversarial.test.js`, existing concurrency suites |
| Restore entered dates/details, cancel edits, update the same quote and remove editing after issue | `integration/frontdesk-quote-edit-browser.test.js` |
| Exact discount arithmetic, single live charge and issued immutability | `property/frontdesk-quote-edit.property.test.js`, seeded fast-check properties; mutation rerun against properties alone |
| Authenticated update route and authoritative route parameter | `integration/frontdesk-http.test.js` |
| 20YD and 40YD payload settings | Guarded live configuration updates and direct readback; `20yd-payload-audit.json` and `40yd-payload-audit.json` in the release directory |

The initial regressions reproduced disappearing tabs and the production deposit
foreign-key failure. Verification caught and corrected draft date restoration.
A browser Close-button selector and the mutation harness's missing public-module
path were corrected without weakening behavioral assertions. The final run above
includes those corrections. Mutants are temporary copies and are removed; release
source hashes are checked for drift.

Limits: this is the affected MBT suite, not every test in the larger repository.
Suite health repeats focused suites in reverse order rather than randomizing the
whole repository. One changed branch was not executed. Browser quote tests use
the real quote services with synthetic external distance/tax adapters. No live
customer orders were created for testing. No formatter script is configured;
existing source conventions and ESLint were used. Dependency audit/license review
was not rerun because dependencies did not change. No migration rollback rehearsal
was needed; deployment retained the previous image and automatic rollback checks.

Payloads use the existing integer-kilogram field: 20YD matches 14YD at 27,215 kg
(about 60,000 lb); previously blank 40YD now holds 36,287 kg (about 80,000 lb).
Conversion rounds down so the configured capacity does not exceed the requested
rating. These are user-authorized configuration changes, verified by readback.

Cleanup completed after every run, including failures: Compose down with volumes
and orphans, disposable artifacts removed, and both `docker ps` and `docker ps -a`
show only the four production containers. The temporary artifact root was removed.
Only source tests/documentation and deployment/operational audit records remain.
