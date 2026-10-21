# Delivery retry and progress — evidence

Spec approval: not obtained (autonomous run under the requested enhancements and established deployment authorization). Tier 3. Review the scope in [the spec](regular-stock-delivery-progress-spec.md).

## Final result

- 265 relevant regression tests passed; 2 unchanged baseline fixture failures; zero new failures.
- 12 real Chromium scenarios passed; 0 page errors.
- 250/250 changed executable lines exercised. Changed branches: 241/259.
- 6/6 manual mutants killed. Progress/context mutants also killed by the property suite alone.
- 7 suites passed in shuffled order (seed 296712441). Strict types and zero new lint diagnostics.
- Source state: `953ebd8c292d47e2e4c9e5653eb90cf0d63e172f76cb48c083affae6f116a437` (SHA-256 of the runtime file hash manifest; dirty workspace preserved, no checkpoint commits).
- Deployed `mbbs-operator-app:regular-stock-delivery-progress-20260930` at 2026-09-30T03:20:49.522826+00:00; exact image `sha256:469363806921a1e10645b24ee6ad2c3608eadae35deef53e7411b758decb92e8`.
- Existing worker, database service and application configuration preserved. Additive migration `241_regular_stock_delivery_operations.sql` applied. App rollback retains operation data.

## Reproduce

From `server/`: `python3 tools/regular-stock-delivery-progress-check.py all` runs migrations, focused regression tests, the full related suite, browser checks, types/lint, shuffled tests, property and mutation checks, changed-line coverage, and the scoped capability/secret scan. It uses the existing isolated `mbbs-regular-v2:test`, `mbbs-regular-v2:e2e` and PostgreSQL 18 images on an internal network with direct NetSuite access disabled. Toolchain: `{"c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "node": "v20.20.2", "playwright": "1.62.1", "typescript": "7.0.2"}`.

Deployment: `python3 tools/regular-stock-delivery-progress-deploy.py prepare`, then `apply`; `verify` repeats read-only deployed checks. The release pins both the prior image and candidate and verifies all runtime files, public assets, health, schema and preserved configuration. Evidence generator: `python3 tools/regular-stock-delivery-progress-evidence.py`.

## Acceptance and failure model mapping

- Immediate HTTP acceptance before a held NetSuite read; readable current phase; interactive request priority: `test/mbt/integration/regular-stock-delivery-progress-http.test.js` and `regular-stock-delivery-progress.test.js`.
- Failed preview, unchanged-input retry, dedicated Sales/SCM retry, disabled existing/new controls, reconnect, page reload and failure after reload: `tools/regular-stock-delivery-progress-browser.mjs`.
- Actual TO stages occur before their side effects and stop on error; asynchronous contexts remain isolated: property tests in `test/mbt/unit/regular-stock-delivery-progress.test.js` (40 concurrent-context examples and 30 stage/failure examples, fixed seeds).
- Concurrent worker attempts and duplicate command replay run once; changed payload rejected; saved requests reused after interruption: Delivery progress integration tests. Existing TO marker/idempotency/partial-print tests remain in the full regression suite.
- Queued permissions rechecked; operation ownership, role/yard revocation, malformed inputs, actor queue limit and staff-scoped browser recovery: progress unit/integration/HTTP tests.
- Session loss stops subsequent stages; orphaned running work becomes visibly interrupted, queued work resumes: integration tests plus the real `startServer()` boot test.
- Queue retention is bounded to one active operation per actor and 30 days for terminal records; migration rollback restores prior rows: HTTP/integration tests.
- Queued → printing → printed follows simulated print-agent records on both pages: real browser tests; no physical printing performed.
- Existing Base/Target direction, full-line then backorder fallback, shortage/PALLET validation, auto/manual routes, Pickup and Stocking: unchanged existing Delivery, regular-stock, transfer-service and adjacent regression assertions; read-only live rule checks.

Browser checks:
- SO line locations derive Base Yard; full-line, backorder fallback and shortage previews calculate units and PALLET
- Sales refreshes actual print-agent status from queued to printing to printed
- Three Delivery inputs; automatic submission creates the TO without a second SO entry
- 150/12441 route waits for SCM; mobile form preserves entered values
- SCM approves the whole SO-based Delivery and automatically creates the TO
- SCM printing retry reuses the committed TO and clears the attention state
- SCM refreshes actual printing and printed status without locking unrelated actions
- Failed check retries unchanged SO; all existing and newly rendered controls disable then restore
- Sales retry reuses the saved SO and creates exactly one TO
- Reload reconnects to the saved operation and restores the preview inputs
- Lost acceptance response resumes the same command; failed resumed preview retains inputs and Retry
- Chinese labels for the simplified Delivery form

## Failures found and resolved

The initial RED run failed all seven initial regressions, including the missing unchanged-input retry and legacy Sales retry action. A later browser RED case proved that a failed read after reload lost the composer; its inputs and Retry are now restored. A separate RED case caught staff account recovery isolation. Assertions were not weakened.

Test setup repairs: SO fixture IDs were randomized to avoid collisions between focused and full runs; the real transfer workflow browser fixture now includes the official PALLET item. Node type declarations were explicitly selected from the existing toolchain. Coverage is collected before every browser reload, since the prior measurement lost earlier page executions. Existing test expectations were retained.

Unchanged baseline failures are `smart-scm-harness.js` ("Expected active item_master input") and `smart-scm-vendor-alternative-harness.js` ("is out of range for type integer"). These are recorded in `tools/regular-stock-v2-baseline-failures.json`; no unrelated fixture changes were made.

## Incident and limits

SOB121732 was readable from NetSuite in approximately 3.4 seconds using interactive priority. Its material line locations indicate Base Yard 2967; one material line had 490 SQFT backordered. At investigation time no saved simple Delivery request or transfer was found from the failed attempt.

The prior Delivery HTTP calls used the background NetSuite queue and stayed open across all external work. [Cloudflare documents 524 as an origin-response timeout](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/). The new path returns a persisted operation promptly and uses short polls with interactive NetSuite priority. Retained logs do not identify the exact step of that user's 524, so background queue delay is an identified vulnerable path, not a proven historical timing trace.

No live TO creation or physical printer test was performed. External order and printer failures were simulated at their boundaries. Physical paper output remains dependent on the yard print agent. An interrupted running process is not automatically replayed: the user explicitly retries against existing SO/TO identities. An extended database or NetSuite outage cannot be prevented by this change.

No dependencies, environment variables or package files changed, so dependency/license audits were not rerun. Capability change: one additive operation table, existing NetSuite priority context, and short authenticated browser polling; no new host, credential, process invocation or network destination in application code.

Final layer timings:
- migrations: exit 0, 6.71 seconds
- focused: exit 0, 4.15 seconds
- regressions: exit 0, 47.86 seconds
- browser: exit 0, 58.38 seconds
- constraints: exit 0, 26.01 seconds
