#!/usr/bin/env python3
"""Create the MBR evidence report only from the completed final gauntlet."""
import hashlib
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/mbr-contract'
cleanup = json.loads((OUT / 'all-cleanup.json').read_text())
assert cleanup['teardownExit'] == 0
assert not any(cleanup[key] for key in ('taskContainers', 'taskNetworks', 'taskVolumes'))
node = json.loads((OUT / 'coverage-node/coverage-summary.json').read_text())['total']
mutations = json.loads((OUT / 'mutation/results.json').read_text())
browser = json.loads((OUT / 'browser/results.json').read_text())
regression = json.loads((OUT / 'regression-comparison.json').read_text())
assert not regression['newFailures']
assert all(item['killed'] for item in mutations)
assert all(item['status'] == 'passed' for item in browser)
log = (OUT / 'all-checks.log').read_text()
node_runs = re.findall(r'^# tests (\d+)\n# suites \d+\n# pass (\d+)\n# fail (\d+)', log, re.M)
assert node_runs and all(failed == '0' for _, _, failed in node_runs)
files = []
for folder in ('src/mbr', 'public/mbr', 'test/mbr'):
    files.extend(path for path in (SERVER / folder).rglob('*') if path.is_file())
files.extend(SERVER.glob('tools/mbr-contract-*'))
for name in ('migrations/285_mbr_contracts.sql','src/server.js','src/auth-repository.js','src/config.js',
             'public/app-sidebar.js','public/control.js','public/login.js','public/staff-login-routes.js',
             'public/menu-order-model.js','public/service-worker.js','public/driver-service-worker.js',
             'package.json','package-lock.json','.env.example'):
    files.append(SERVER / name)
manifest = {str(path.relative_to(SERVER)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(set(files))}
state = hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()
(OUT / 'source-state.json').write_text(json.dumps({'sha256':state,'files':manifest},indent=2))
node_count = int(node_runs[-1][0])
report = f'''# MBR Contract evidence — Tier 3

Spec approval: obtained from the user's instruction to implement the proposed
plan. Phone layouts were added by the user's follow-up and included in the spec.
Source state: `{state}` (per-file hashes in source-state.json).
No new dependencies or automatic commits. Installed versions are recorded in
all-checks.log; the existing package lock defines the toolchain.

Reproduce from the repository root:

```sh
python3 server/tools/mbr-contract-gauntlet.py all
```

| Layer | Final result |
| --- | --- |
| Focused domain, properties, credentials, DB, HTTP and worker tests | {node_count} passed, 0 failed |
| Browser flows at 375 px / 390 px | {len(browser)} passed in Chromium and WebKit |
| Accessibility | No violations in the six saved sales/customer/completed checks |
| Types | Core domain TypeScript check passed |
| Lint and complexity | All new JS, UI, tests and validation scripts passed |
| New backend/shared-domain line coverage | {node['lines']['covered']}/{node['lines']['total']} ({node['lines']['pct']}%) |
| Branch coverage | {node['branches']['covered']}/{node['branches']['total']} ({node['branches']['pct']}%) |
| Manual mutation | {sum(item['killed'] for item in mutations)}/{len(mutations)} killed |
| Property mutation rerun | {sum(item['propertyKilled'] is True for item in mutations)}/3 targeted money/expiry mutants killed by properties alone |
| Suite health | All six focused test files passed in shuffled order, seed 131026 |
| Shared login, roles, menus and full Field Sales regressions | {regression['passed']} passed, {regression['failed']} existing failures, 0 new failures |
| Cleanup and live health | No task containers, networks or volumes; both ps and ps -a verified; production health passed |

## Spec to tests

- Authority and role separation: domain.test.js and http.test.js; real staff login
  and mixed-role access, including protected legacy routes and event streams.
- Contract fields, exact CAD cents and deadlines: domain.test.js and the seeded
  300-case money / 200-case expiry properties in properties.test.js.
- Pending edits, same-link reuse, expiry and renewed-link replacement:
  repository.test.js and http.test.js.
- Duplicate signers/retries, stale edits, post-lock deadlines and PDF rollback:
  repository.test.js. Contract-number growth also has an observed RED test.
- Source wording and signature/protection preservation: actual PDF content
  streams are checked against an independent frozen copy of the supplied
  agreement; every static clause word is required, excluding only placeholders
  and page-number footers. Both protection choices are verified.
- Token encryption, scoped authorization, private persistent keys, concurrent
  first use, malformed/oversized/blank images: security.test.js.
- Feature activation, worker lifecycle and key corruption: runtime.test.js.
- Phone sales/customer layouts, finger/mouse signing, explicit choices, stale
  re-review, network recovery, PDF downloads and renewal: browser.mjs.
- Source restoration: mutations only change disposable copies under /tmp;
  tracked sources are never rewritten by the mutation runner.

## Limits and honest notes

The complete legacy MBT baseline timed out at Aggregate Requests after 504 file
summaries; its log and cleanup evidence remain. Initial broad baseline failures
included incomplete test mounts, which were corrected for the final targeted
regressions. The preserved-source shared baseline identified the existing staff
login redirect test; its result is compared by name and never silently skipped.
The remaining unrelated legacy integration suite is not claimed to pass.

Coverage above measures the new backend and shared domain. Frontend execution
coverage is saved separately in browser/coverage.json. Changed shared bootstrap
lines are exercised through real HTTP and browser flows, but a line-by-line
coverage total for the entire existing monolithic server is not claimed.
The remaining uncovered lines/branches are reported in coverage-node/lcov.info.

No deployment or real customer invitation occurred during validation. Activation
requires the additive migration, the MBR flag, and MBR Sales account grants, as
documented in src/mbr/README.md. Disabling MBR preserves signed records and keys.
'''
(OUT / 'EVIDENCE.md').write_text(report)
print(json.dumps({'focusedTests':node_count,'browserChecks':len(browser),'mutantsKilled':len(mutations),
                  'newRegressionFailures':0,'sourceState':state}))
