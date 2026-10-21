#!/usr/bin/env python3
"""Build evidence from the exact-candidate customer signing checks."""
import difflib
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/mbr-signing-defaults'
RELEASE = SERVER / 'deployments/mbr-signing-defaults-20261014'
data = json.loads((OUT / 'checks.candidate.json').read_text())
checks = data['results']
prepared = json.loads((OUT / 'prepared.json').read_text())
validation = json.loads((OUT / 'validation.candidate.json').read_text())
cleanup = json.loads((OUT / 'cleanup.candidate.json').read_text())
assert validation['passed'] and validation['cleanupVerified']
assert all(row['exit'] == 0 for row in checks.values())
assert cleanup['teardownExit'] == 0
assert not any(cleanup[key] for key in ('containers', 'networks', 'volumes'))
browser = json.loads((OUT / 'browser/results.json').read_text())
legacy = json.loads((OUT / 'contract-browser/results.json').read_text())
mutants = json.loads((OUT / 'mutations/results.json').read_text())
assert all(row['status'] == 'passed' for row in browser + legacy)
assert all(row['killed'] for row in mutants)
target = RELEASE / 'context/public/mbr/customer.js'
before = RELEASE / 'before/public/mbr/customer.js'
source = target.read_text()
lines = source.splitlines(keepends=True)
changed = set()
for tag, _a, _b, start, end in difflib.SequenceMatcher(a=before.read_text().splitlines(), b=source.splitlines()).get_opcodes():
    if tag in ('insert', 'replace'):
        changed.update(range(start + 1, end + 1))
entries = [item for item in json.loads((OUT / 'browser/coverage.json').read_text())
           if '/mbr/customer.js' in item.get('url', '') and item.get('source') == source]
assert entries, 'Coverage must contain the exact candidate customer source'
coverage = {}
for number in sorted(changed):
    line = lines[number - 1]
    anchor = sum(len(value) for value in lines[:number - 1]) + len(line) - len(line.lstrip())
    count = 0
    for entry in entries:
        ranges = [region for function in entry['functions'] for region in function['ranges']
                  if region['startOffset'] <= anchor < region['endOffset']]
        if ranges:
            count = max(count, min(ranges, key=lambda region: region['endOffset'] - region['startOffset'])['count'])
    coverage[str(number)] = {'covered': count > 0, 'count': count}
assert all(row['covered'] for row in coverage.values()), coverage
(OUT / 'changed-frontend-lines.json').write_text(json.dumps(coverage, indent=2))
source_hash = hashlib.sha256(json.dumps(prepared['sourceHashes'], sort_keys=True).encode()).hexdigest()
report = f'''# Customer signing order and defaults — evidence

Spec: test/mbr/signing-defaults-spec.md. Spec approval was not obtained before
implementation (autonomous run); no independent pre-code specification review is
claimed. User requested signing second, protection accepted and consent checked.

Runtime source hash: `{source_hash}`. Candidate: `{prepared['image']}`.
Node: {data['node']}. Existing pinned toolchain: server/package.json and package-lock.json.
Reproduce: `python3 server/tools/mbr-signing-defaults-gauntlet.py candidate` with the
prepared image and existing tool/browser caches. Prepare via
`python3 server/tools/mbr-signing-defaults-release.py prepare` and generate this
report with `python3 server/tools/mbr-signing-defaults-evidence.py`.

| Layer | Final fresh result |
| --- | --- |
| Full MBR backend suite under coverage | {checks['tests']['pass']} passed, {checks['tests']['fail']} failed |
| New Chrome desktop/phone and WebKit phone checks | {len(browser)} passed |
| Existing phone signing/renewal/network-retry/PDF checks | {len(legacy)} passed |
| Changed frontend executable lines | {len(coverage)}/{len(coverage)} covered by exact-source Chromium execution |
| Focused browser mutations | {len(mutants)}/{len(mutants)} killed on behavioral assertions |
| Strict shared-core types / MBR lint | 0 errors; 0 lint warnings |
| Runtime-delta secrets | 0 findings |
| Cleanup | bounded standard Compose, mbbs-tests.slice, init, finally teardown; no task containers, database storage, volumes or networks; ps/ps-a and production health checked |

Spec mapping:

- Signing second/full agreement third and all 14 clauses: initial DOM assertions.
- Accept checked, Decline unchecked, consent checked, no automatic submission:
  independent initial checks; removing either checked attribute fails its test.
- Required signature and unchecked consent: browser request counts remain zero;
  existing HTTP tests still reject consent=false and invalid signature input.
- Default acceptance and explicit decline: real signed snapshots, captured POST
  payloads and downloaded PDFs match the actual choice in all three viewports.
- Stale refresh: new terms/defaults appear; attempting to sign without redrawing
  sends no request. Existing signature replay/version/expiry protections remain in
  the complete backend and signing browser suites.
- Completed views: no signing form; existing signed document behavior is retained.
- UI: accessibility has zero violations and all tested viewports have no horizontal
  overflow; screenshots and PDFs are retained under browser/.
- Release: only customer.js and its sign.html cache version change; no schema,
  agreement text, staff form, rate table or backend behavior changes.

Observed RED: all three new layout/default assertions failed against the old UI.
The first attempt exposed a test-only base-URL mismatch, corrected before obtaining
behavioral RED. The first candidate's accepted path passed; later cases needed a
fresh document when visiting a different fragment-token link rather than reusing
the previous contract page. Test navigation was corrected without changing any
assertion or application code. Existing browser assertions for empty choices after refresh were
explicitly changed to the user-requested defaults before implementation. No signing
validation assertion was weakened. The blank-signature guard mutant also verifies
that retained protection is exercised by the new browser suite.

Limits/skips: no dependency audit because dependencies did not change. No new math
or parsing properties apply to this markup change; existing money/model properties
remain in the full backend suite. Browser scenarios repeat across three engine/
viewport combinations; backend random ordering was not repeated because backend
logic is unchanged. Unchanged equipment/rate browser suites were not repeated after
their preceding successful release. HTML cache versioning is verified through the
candidate page and runtime hashes, rather than a numeric HTML coverage claim.
These checks cover the stated behaviors and do not establish exhaustive proof.
'''
(OUT / 'EVIDENCE.md').write_text(report)
print(json.dumps({'tests': checks['tests']['pass'], 'browserChecks': len(browser) + len(legacy),
                  'mutantsKilled': len(mutants), 'changedFrontendLinesCovered': len(coverage),
                  'evidence': str(OUT / 'EVIDENCE.md')}))
