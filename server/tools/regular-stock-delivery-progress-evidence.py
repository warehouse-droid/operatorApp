"""Generate evidence only from the final successful run and verified release."""
import hashlib
import json
import re
from pathlib import Path
s=Path(__file__).resolve().parents[1]
o=s/'test-artifacts/regular-stock-delivery-progress'
checks=json.loads((o/'checks.json').read_text())
results=json.loads((o/'all-results.json').read_text())
assert all(row['exitCode']==0 for row in results)
assert checks['sourceHashes']=={f:hashlib.sha256((s/f).read_bytes()).hexdigest() for f in checks['sourceHashes']}
summary=json.loads((o/'all-regressions.log').read_text().splitlines()[0])
browser=json.loads((o/'browser.json').read_text())
release=json.loads((s/'deployments/regular-stock-delivery-progress-20260930/result.json').read_text())
assert release['deployed'] and not summary['newFailures']
coverage=checks['coverage'];assert not coverage['uncovered'] and not coverage['missingFiles']
text=f'''# Delivery retry and progress — evidence

Spec approval: not obtained (autonomous run under the requested enhancements and established deployment authorization). Tier 3. Review the scope in [the spec](regular-stock-delivery-progress-spec.md).

## Final result

- {summary['passed']} relevant regression tests passed; {summary['baselineFixtureFailures']} unchanged baseline fixture failures; zero new failures.
- {len(browser['checks'])} real Chromium scenarios passed; {len(browser['errors'])} page errors.
- {coverage['covered']}/{coverage['total']} changed executable lines exercised. Changed branches: {coverage['branches']['covered']}/{coverage['branches']['total']}.
- {len(checks['mutants'])}/{len(checks['mutants'])} manual mutants killed. Progress/context mutants also killed by the property suite alone.
- {len(checks['suiteOrder'])} suites passed in shuffled order (seed {checks['shuffleSeed']}). Strict types and zero new lint diagnostics.
- Source state: `{checks['sourceTreeSha256']}` (SHA-256 of the runtime file hash manifest; dirty workspace preserved, no checkpoint commits).
- Deployed `{release['image']}` at {release['at']}; exact image `{release['imageId']}`.
- Existing worker, database service and application configuration preserved. Additive migration `241_regular_stock_delivery_operations.sql` applied. App rollback retains operation data.

## Reproduce

From `server/`: `python3 tools/regular-stock-delivery-progress-check.py all` runs migrations, focused regression tests, the full related suite, browser checks, types/lint, shuffled tests, property and mutation checks, changed-line coverage, and the scoped capability/secret scan. It uses the existing isolated `mbbs-regular-v2:test`, `mbbs-regular-v2:e2e` and PostgreSQL 18 images on an internal network with direct NetSuite access disabled. Toolchain: `{json.dumps(checks['toolchain'],sort_keys=True)}`.

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
'''+'\n'.join('- '+item for item in browser['checks'])+f'''

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
'''+'\n'.join(f"- {row['layer']}: exit {row['exitCode']}, {row['seconds']} seconds" for row in results)+'\n'
(s/'test/regular-stock-delivery-progress-evidence.md').write_text(text)
print(json.dumps({'evidence':str(s/'test/regular-stock-delivery-progress-evidence.md'),'regressions':summary,'changedLines':coverage['covered'],'browserChecks':len(browser['checks']),'mutants':len(checks['mutants'])}))
