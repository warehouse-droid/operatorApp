#!/usr/bin/env python3
"""Generate the model-rate evidence report from the final candidate checks."""
import difflib
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/mbr-rates'
RELEASE = SERVER / 'deployments/mbr-rates-20261014'
checks = json.loads((OUT / 'checks.candidate.json').read_text())['results']
prepared = json.loads((OUT / 'prepared.json').read_text())
validation = json.loads((OUT / 'validation.candidate.json').read_text())
cleanup = json.loads((OUT / 'cleanup.candidate.json').read_text())
assert validation['passed'] and validation['cleanupVerified']
assert all(record['exit'] == 0 for record in checks.values())
assert cleanup['teardownExit'] == 0
assert not any(cleanup[key] for key in ('containers', 'networks', 'volumes'))
mutants = json.loads((OUT / 'mutations/results.json').read_text())
assert all(record['killed'] for record in mutants)
browser = json.loads((OUT / 'browser/results.json').read_text())
assert all(record['status'] == 'passed' for record in browser)
coverage = json.loads((OUT / 'coverage-candidate/coverage-final.json').read_text())
changed = {}
for name in ['public/mbr/rates.js', 'src/mbr/rates-repository.js', 'src/mbr/router.js']:
    target = RELEASE / 'context' / name
    before = RELEASE / 'before' / name
    old = before.read_text().splitlines() if before.exists() else []
    added = set()
    for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old, b=target.read_text().splitlines()).get_opcodes():
        if tag in ('insert', 'replace'):
            added.update(range(start + 1, end + 1))
    record = coverage['/app/' + name]
    counts = {}
    for key, location in record['statementMap'].items():
        for line in range(location['start']['line'], location['end']['line'] + 1):
            counts[line] = max(counts.get(line, 0), record['s'][key])
    measured = added.intersection(counts)
    changed[name] = {'measured': len(measured), 'covered': sum(counts[line] > 0 for line in measured),
                     'uncovered': sorted(line for line in measured if counts[line] == 0)}
(OUT / 'changed-line-coverage.json').write_text(json.dumps(changed, indent=2))
covered = sum(record['covered'] for record in changed.values())
measured = sum(record['measured'] for record in changed.values())
assert covered == measured, 'An executable changed backend/shared line lacks coverage'
source_hash = hashlib.sha256(json.dumps(prepared['sourceHashes'], sort_keys=True).encode()).hexdigest()
report = f'''# MBR rental rate defaults — evidence

Spec approval: not obtained (autonomous run). User requirements are in
`test/mbr/rates-spec.md`; no independent specification review is claimed. Tier 3
checks address price accuracy, contract snapshots, nullable values, authorization,
concurrent edits and migration/release integrity. No dependencies or commits added.

Source hash: `{source_hash}`. Runtime candidate: `{prepared['image']}`.
Reproduce: `python3 server/tools/mbr-rates-gauntlet.py candidate` with the prepared
image and the existing repository tool/browser caches. To build the candidate:
`python3 server/tools/mbr-rates-release.py prepare`. Workspace validation:
`python3 server/tools/mbr-rates-gauntlet.py all`. Generate this report:
`python3 server/tools/mbr-rates-evidence.py`.

| Layer | Final fresh result |
| --- | --- |
| Complete MBR suite | {checks['tests']['pass']} passed, {checks['tests']['fail']} failed |
| Reverse file-order MBR suite | {checks['shuffled-tests']['pass']} passed, {checks['shuffled-tests']['fail']} failed |
| New Chromium desktop/phone and WebKit phone scenarios | {len(browser)} passed |
| Existing equipment, nullable-contract and signing/PDF browser suites | all three passed |
| Shared-domain strict types | 0 errors |
| MBR JavaScript lint | 0 errors/warnings |
| Changed executable backend/shared statements by line | {covered}/{measured} covered |
| Deliberate mutations | {sum(row['killed'] for row in mutants)}/{len(mutants)} killed |
| Property checks | 300 seeded nullable money/model cases; three corresponding mutants killed by properties alone |
| Migration | disposable transaction rollback preserved equipment and contract/event counts |
| Secrets/capabilities | 0 runtime-delta findings; only authenticated rate storage/read and form behavior added |
| Host cleanup | bounded standard Compose; task containers, volumes and networks removed; ps/ps -a and production health verified |

Spec mapping:

- Exact initial rates, both STR1000H/ATL1000 and ER636H Cab: fixture, HTTP seed
  comparison and every-model browser selection.
- Unpriced AX18/new models and blank/zero distinction: rates unit/property tests,
  new-model HTTP tests and browser save/reload checks.
- Model changes clear old serial/rates; serial changes preserve overrides:
  rates-browser.mjs, including real editable controls in three browser/viewports.
- Override/clear/save/reopen, Setup repricing, PDF and renewal: rates HTTP/browser
  tests plus the full pre-existing signed-PDF immutability and renewal suites.
- Invalid money, unknown models, other roles and customer tokens: negative HTTP
  tests. Concurrent first writes and stale updates: conflicting HTTP edit tests.
- Setup values persist; invalid submissions retain input and Cancel discards edits:
  real-browser tests with accessibility and viewport checks.
- Transaction rollback and live isolation: migration rehearsal, narrow three-way
  merge over the live image, source hashes and unchanged-service/config guards.

Observed RED: all 11 new unit/HTTP requirements failed against the original
application (404 endpoints and behavioral stubs). Validation caught an absent
mutation runner and a shadowed callback variable before implementation tests ran.
Test fixture isolation was then corrected so repeated suites start from the same
initial rates without weakening assertions. A later run was interrupted during an
existing WebKit equipment test when concurrent stacks caused resource contention.
Its task stack was removed. Validation deadlines now force-stop subprocesses, and
the complete final run used a fresh stack over the latest live base image. Logs
retain the failures and interrupted-run evidence. The final live base was near
Docker's layer mount limit; the release builder now copies the same nine runtime
files in one layer instead of three. No production files were changed by the
failed build, and the resulting image was validated in isolation.

Limits: numeric coverage covers shared/backend changes. UI/CSS behavior is checked
by real browsers, accessibility, viewport checks and a deliberately broken form
mutation; no numeric frontend coverage is claimed. SQL is checked against PostgreSQL,
not statically typed. A randomized test scheduler was not added; the suite was
repeated with reversed file arguments. Unrelated MBBS suites were not rerun because shared server,
navigation and dependency files were not changed. Dependency audit was not repeated
because the dependency set is unchanged. These checks cover the stated behaviors
and do not establish exhaustive proof.
'''
(OUT / 'EVIDENCE.md').write_text(report)
print(json.dumps({'evidence': str(OUT / 'EVIDENCE.md'), 'tests': checks['tests']['pass'],
                  'browserScenarios': len(browser), 'mutantsKilled': len(mutants),
                  'changedLinesCovered': covered, 'changedLinesMeasured': measured}))
