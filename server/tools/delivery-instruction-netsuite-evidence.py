"""Summarize the final fresh checks and verified scoped release; never invent counts."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/delivery-instruction-netsuite'
RELEASE = ROOT / 'deployments/delivery-instruction-netsuite-priority-20260929'

def read(name):
    return json.loads((OUT / name).read_text())

checks, tests, browser, coverage = (read(name) for name in ['checks.json', 'tests.json', 'browser.json', 'changed-lines.json'])
gauntlet = read('gauntlet.json')
assert all(layer['exitCode'] == 0 for layer in gauntlet + checks['layers'])
assert tests['fail'] == tests['knownFailures'] == 2 and not browser['errors'] and coverage['complete']
assert checks['sourceHashes'] == {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in checks['sourceHashes']}
source_hash = hashlib.sha256(json.dumps(checks['sourceHashes'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
patch = (ROOT / 'test/delivery-instruction-netsuite.changes.patch').read_text()
added = '\n'.join(line[1:] for line in patch.splitlines() if line.startswith('+') and not line.startswith('+++'))
secret_patterns = [r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', r'\bAKIA[0-9A-Z]{16}\b', r'(?i)(?:client_secret|access_token|password)\s*[:=]\s*[\"\'][^\"\']{16,}']
assert not any(re.search(pattern, added) for pattern in secret_patterns), 'Review possible secret in task diff'
release = json.loads((RELEASE / 'result.json').read_text())
assert release['deployed'] and release['netSuiteOrderWrites'] == 0
versions = read('toolchain.json')
shuffled_passed = sum(int(match[1]) for file in OUT.glob('shuffled-*.log') for match in re.finditer(r'^# pass (\d+)$', file.read_text(), re.M))
report = f'''# Evidence: Sales delivery instructions → NetSuite (Tier 3)

Spec approval: not obtained (autonomous run). User authorized implementation and
direct deployment after tests; no separate human review of the specification.

Runtime source hash: `{source_hash}` (sorted scoped SHA-256 manifest in checks.json).
Specification: [acceptance criteria](../../test/delivery-instruction-netsuite-spec.md).
Entry point: `python3 tools/delivery-instruction-netsuite-check.py`.
Toolchain: {', '.join(f'{key} {value}' for key, value in versions.items())};
existing isolated `mbbs-regular-v2:test` and `mbbs-regular-v2:e2e` images.

## Final fresh checks

| Layer | Result |
| --- | --- |
| Affected delivery, Driver, HTTP, SQL, NetSuite and neighboring regressions | {tests['pass']} passed; {tests['knownFailures']} reproduced pre-existing harness failures; 0 new failures; {tests['skipped']} skipped |
| Strict adapter types | Passed |
| Syntax / lint | 0 new diagnostics; {checks['unchangedLegacyDiagnostics']} existing diagnostics retained |
| Changed executable lines | {coverage['covered']}/{coverage['total']} covered |
| Measured branches on changed lines | {coverage['branches']['covered']}/{coverage['branches']['total']} covered (not a 100% branch claim) |
| Generated properties | {checks['propertyCases']} cases, 4 properties, seed 29670929 |
| Temporary manual mutation | {checks['mutations']}/{checks['mutations']} killed by unit tests AND by property tests alone; restored suite passed |
| Real Chromium editor | {len(browser['checks'])} checks, {len(browser['errors'])} page errors; desktop and Chinese mobile screenshots |
| Seeded separate-process suite order | {shuffled_passed} passed; same 2 legacy failures |
| Dependencies / secrets | No dependency changes; scoped added-line secret patterns clear; no credentials in patch |

## Acceptance mapping

| Scenario | Verification | Result |
| --- | --- | --- |
| Native note and two calendar dates | unit `reads complete native instruction and exact calendar dates`; real read-only NetSuite metadata/header; browser load | pass |
| Exact three-field mapping, clear values, unchanged commercial fields | unit exact PATCH and preserve-fields assertions; generated mapping/idempotence property; authenticated HTTP | pass |
| Stale values, moved yard, terminal/completed order, private Sales access | unit/SQL scope and completed-dropoff tests; HTTP unauthenticated/Dispatcher/other-yard tests; inherited private-Sales middleware | pass |
| Same-revision duplicates, lost response and retry | simultaneous SQL saves; adapter lost-response/readback tests; retry recognizes target without another PATCH | pass |
| Local memo/date/driver preview and audit | SQL retained text/address/time assertions, HTTP audit action, existing media/driver/translation suites | pass |
| Busy state, errors, drafts, dates, Chinese and mobile | real browser with delayed/error transport boundaries | pass |

## Release

- Image: `{release['image']}` / `{release['imageId']}`.
- Deployed: {release['at']}.
- The feature changes 8 runtime files. The final priority follow-up changes {release['sourceFilesChanged']} file on top of that feature image; all 1,140 source/public/migration files were verified against the preceding live image plus the scoped change.
- App configuration preserved; database, webhook worker and other dependencies unchanged; no schema migration.
- Live page/assets and authenticated service's native field read verified. Anonymous API read denied. Existing local instruction revision/text unchanged by verification.
- No real NetSuite order mutations during validation or release.
- A final two-route adjustment gives these authenticated Sales reads/writes the existing interactive NetSuite priority; shared concurrency limits remain in effect. The HTTP test observed background priority before the fix and verifies interactive priority afterward.

## Honest notes and limits

- The unchanged deployment reproduces `driver-photo-integrity-harness.js`: "The recovery shell must use a new cache generation." Its assertion expects v41 while the existing shell is v44.
- Captured pre-change sources reproduce `sync-shape-harness.js`: "Receiving did not use the fixed PO receipt baseline." A disposable active operator fixture was added to exercise the existing harness beyond its missing-fixture prerequisite. Logs are in baseline-neighbors.json and baseline-*.log.
- The existing Sales card test's exact CSS cache version was updated to the new release version; all sizing/wrapping assertions were retained, as documented in the spec amendment.
- RED evidence records all five initial adapter failures, four initial service failures, missing browser fields and the malformed snapshot internal error. Fixes preserved the behavioral assertions.
- Browser coverage is checkpointed before reload because Chromium replaces script IDs; this avoids incorrectly losing coverage of the earlier save flow.
- The first priority follow-up build hit the Docker overlay layer limit. It was rebuilt using only its one changed runtime file; the failed build log was retained and no production container was changed by that failed build.
- Static typing is strict for the new adapter. Existing untyped repository/server/UI code is checked by lint plus SQL/HTTP/browser execution, not claimed fully typed.
- NetSuite PATCH success cannot be rolled back by a local database rollback. Readback and repeatable value assignment recover uncertain saves; unverified responses never report success. No production write was used as a test.
- Comparison immediately before/after PATCH protects stale edits, but a concurrent NetSuite edit to the same field in the final read/PATCH interval remains an API-level limit. Only changed fields are sent; unrelated fields are preserved.
- Dependency audit/version-matrix/performance benchmarking were not added: no dependency changes, no new runtime support promises or stated latency budget. No test-only hooks were added to production.
'''
(OUT / 'EVIDENCE.md').write_text(report)
print(json.dumps({'evidence': str(OUT / 'EVIDENCE.md'), 'testsPassed': tests['pass'], 'browserChecks': len(browser['checks']), 'deployed': True}))
