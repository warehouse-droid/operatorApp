# 150 Sales Regular Stock Delivery — evidence

Enabled on https://test.mbbsoperation.com at 2026-10-05T15:23:47.662752+00:00. Sales users with yard 150 assigned can create and reopen SO-based Regular Stock Delivery for 3445 → 2967 and 2967 → 3445. Other workflow and route permissions retain their previous rules.

Spec approval: not obtained (autonomous run). Tier 3: inventory authorization. The specification and tests were authored in the same autonomous session; they provide auditable evidence within the specification, without independent spec review.

## Specification and executable checks

The acceptance contract is [regular-stock-150-sales-spec.md](regular-stock-150-sales-spec.md). Location IDs: 150 = 26, 3445 = 1, 2967 = 28.

| Spec behavior | Executable evidence |
| --- | --- |
| Initial SO lookup at either paired Base Yard | Integration: `150-only Sales previews each SO Base Yard before selecting the supplying yard`; unit discovery cases; desktop and phone browser execution |
| Create both directions and preserve automatic approval, calculated items, transfer and retry behavior | Integration: `150-only Sales submits both routes, reads and lists them, and duplicates and retries reuse the TO`; existing Delivery calculation, handoff and concurrency suites; browser submissions |
| List/detail/vendor/operation access and revocation | SQL/detail scope matrix; real authenticated HTTP list/detail; asynchronous preview, submit, retry and completed-result checks; queued work and retry revocation checks; browser HTTP revocation |
| Narrow exception: current regular Delivery only | Record scope property (1,000 examples); focused other-method property (300 examples); SQL/detail matrix; Pickup/Stocking/historical/other-account integration cases |
| Preserve all other routes and reject hostile inputs | Route authorization property (600 examples); hostile yard inputs; integration denial before external reads; existing SO/material/quantity domain regressions |
| Keep the server-derived Base Yard in the composer and restore 150 for other methods | Browser covers both directions, a refresh request, saved-request reload, and switching Delivery → Pickup/Stocking |

Tests: `test/mbt/unit/regular-stock-150-sales.test.js` and `test/mbt/integration/regular-stock-150-sales.test.js`; browser: `tools/regular-stock-150-sales-browser.mjs`. The current focused suite contains 14 tests.

## Final fresh gauntlet

Run from the repository root:

```sh
python3 server/tools/regular-stock-150-sales-check.py all
```

Prerequisites: existing Docker/sudo access and the locally available `postgres:18-alpine`, `mbbs-regular-v2:test`, and `mbbs-regular-v2:e2e` images. The persisted runner uses a fresh disposable PostgreSQL database, an internal Docker network, read-only source mounts and disabled external integrations. It removes the disposable database and network after execution. NetSuite and printer boundaries are substituted; application services, repositories, authentication, HTTP handlers, queues and SQL execute normally.

| Layer | Final result |
| --- | --- |
| Related regression suite | 350 passed across 57 files; 0 new failures; 1 known baseline fixture failure |
| Real browser | 7 checks; both routes submitted and reopened; 2 isolated transfer records; 0 page errors |
| Syntax | Five changed JavaScript files checked successfully |
| Types | Strict TypeScript check passed for the new authorization helper and existing Delivery domain |
| Lint | Zero new diagnostics against the captured baseline, including new test and runner files |
| Changed executable lines | 52/52 executed; zero missing source files |
| Changed branches | 40/41 executed |
| Manual mutations | 5/5 killed; restored suite passed |
| Properties | 1900 generated examples with fixed seeds; route, permission-gate and method mutants also killed by the property suite alone |
| Suite health | Focused unit and integration suites repeated in the opposite order from the broad run; restored-mutant suite also passed |
| Supply chain and capability review | No dependency, schema or role changes; no new production filesystem, environment, subprocess or external-network capability; changed lines scanned for secrets |
| Complexity | Small route/access predicates and one shared SQL scope; existing creation and handoff logic retained |

Final layer exit codes are all zero: migrations (7.37 s), regressions (97.49 s), browser (14.1 s), constraints (17.86 s). Toolchain: node v20.20.2, fast-check 4.9.0, c8 12.0.0, eslint 10.8.0, typescript 7.0.2, playwright 1.62.1.

Tested production source hash: `32062892c6437529a8a1e46d93033bcde6cdb402c519ae9122a82fffdd37b2b2`. Per-file hashes, versions and mutation results are in `test-artifacts/regular-stock-150-sales/checks.json`; suite, browser, coverage, baseline and RED logs are stored in the same artifact directory.

Manual mutants remove the reverse route, remove the 150 permission requirement, admit other methods, disable initial Base Yard discovery, and omit the current workflow gate from list SQL. The first three were additionally run against properties alone. The SQL mutant is required to fail the specific SQL/detail scope test, preventing fixture failures from counting as kills.

## Baseline, RED and limits

The captured baseline passed 336 tests with one existing Smart SCM harness failure: `Expected active item_master input`. The final run retains that same failure and introduces none. An existing Resolve browser screenshot occasionally reports `locator.screenshot: Element is not attached to the DOM`; this was reproduced against the original production files. That test passed in the final run. Neither unrelated test was changed.

Before implementation, the focused RED run recorded 11 failures and 2 passes, including yard-forbidden failures for valid paired submissions and SO discovery. The original client also rejected the new destination during browser execution. A wrong-method mutant initially survived the broad record property; the added conditional method property exposed it, and all final selected mutants were killed.

Test fixture corrections retained the assertions: unique inventory vendor updates on repeated runs, waiting for authenticated page initialization, normal Accepted-tab navigation after reload, waiting for the existing mobile sidebar transition, and ending UI polling before the deliberate HTTP revocation check. Final results above come from one fresh run after these corrections and the final production source edits.

Coverage measures changed code, not the whole repository. The one unexecuted changed branch is the defensive empty-array fallback for a null authorization context in the repository; normal authenticated requests supply arrays. Full-project unrelated subsystems were not rerun: the gauntlet covers all regular-stock and legacy stock-request suites plus neighboring Smart SCM checks. Dependencies were unchanged, so a new dependency audit/license review was not run. No full-suite randomized-order tool was added; the focused suites were repeated in alternate order. Live NetSuite creation and printer execution were not exercised. These limits remain outside the demonstrated evidence.

## Deployment and live verification

The release overlays only six reviewed files onto the current app image. A concurrent `special-unit-identity-20261005` release was detected during preparation; every scoped baseline file still matched the original capture. The candidate was rebuilt on that latest image, preserving that release. All 1,254 files in `src`, `public` and `migrations` were compared against the expected complete tree. Production-image module imports passed. App configuration and database, Ollama and webhook-worker containers were preserved. No schema migration was applied to the live database.

The persisted release workflow is `tools/regular-stock-150-sales-deploy.py` (`prepare`, `apply`, `verify`). It checks tested hashes, the current app and dependency state, configuration parity and idle business-operation queues before replacing the app. An immutable previous image and rollback compose file are retained; rollback is automatic on verification failure. No live rollback was needed or rehearsed.

Deployed image: `mbbs-operator-app:regular-stock-150-sales-20261005`. Public health and JavaScript hash checks returned HTTP 200, and the served HTML includes the updated cache key. Read-only live checks found 8 active Sales accounts with 150 access and 5 permitted paired deliveries among 17 visible requests. They verified both route permissions, cross-yard detail access, denial for another yard account, and the original 150 destination filter for other workflows. Verification created zero orders, zero NetSuite calls and zero print jobs.

Sanitized deployment evidence and the rollback files are retained at `/home/ubuntu/operatorapp-investigations/regular-stock-150-sales-20261005/release`. Full container captures containing configuration are kept separately in private files with restricted permissions.
