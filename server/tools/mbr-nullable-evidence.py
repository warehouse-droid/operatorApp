#!/usr/bin/env python3
"""Build the MBR equipment evidence report from completed candidate checks."""
import difflib
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/mbr-nullable'
RELEASE = SERVER / 'deployments/mbr-nullable-20261013'
checks = json.loads((OUT / 'checks.candidate.json').read_text())['results']
validation = json.loads((OUT / 'validation.candidate.json').read_text())
prepared = json.loads((OUT / 'prepared.json').read_text())
cleanup = json.loads((OUT / 'cleanup.candidate.json').read_text())
assert validation['passed'] and validation['cleanupVerified']
assert not any(cleanup[key] for key in ('containers', 'networks', 'volumes'))
assert cleanup['teardownExit'] == 0
for name, record in checks.items():
    assert record['exit'] == 0, name
coverage = json.loads((OUT / 'coverage-candidate/coverage-summary.json').read_text())
map_data = json.loads((OUT / 'coverage-candidate/coverage-final.json').read_text())
mutants = json.loads((OUT / 'mutations/results.json').read_text())
browser = json.loads((OUT / 'browser/results.json').read_text())
legacy_browser = json.loads((OUT / 'contract-browser/results.json').read_text())
equipment_browser = json.loads((SERVER / 'test-artifacts/mbr-equipment/browser/results.json').read_text())
assert all(row['killed'] for row in mutants)
assert all(row['status'] == 'passed' for row in browser + legacy_browser + equipment_browser)
state = hashlib.sha256(json.dumps(prepared['sourceHashes'], sort_keys=True).encode()).hexdigest()
changed = {}
for name in ['public/mbr/domain.js', 'public/mbr/equipment.js', 'public/mbr/ui.js', 'src/mbr/repository.js', 'src/mbr/equipment-repository.js', 'src/mbr/agreement.js']:
    target = RELEASE / 'context' / name
    before = RELEASE / 'before' / name
    old_lines = before.read_text().splitlines() if before.exists() else []
    new_lines = target.read_text().splitlines()
    added = set()
    for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old_lines, b=new_lines).get_opcodes():
        if tag in ('insert', 'replace'):
            added.update(range(start + 1, end + 1))
    record = map_data['/app/' + name]
    counts = {}
    for key, location in record['statementMap'].items():
        for line in range(location['start']['line'], location['end']['line'] + 1):
            counts[line] = max(counts.get(line, 0), record['s'][key])
    measured = added.intersection(counts)
    changed[name] = {'measured': len(measured), 'covered': sum(counts[line] > 0 for line in measured),
                     'uncovered': sorted(line for line in measured if counts[line] == 0)}
changed_total = sum(row['measured'] for row in changed.values())
changed_covered = sum(row['covered'] for row in changed.values())
(OUT / 'changed-line-coverage.json').write_text(json.dumps(changed, indent=2))
assert changed_covered == changed_total, 'An executable changed backend/shared line lacks coverage'
total = coverage['total']
report = f'''# Nullable MBR contract fields — evidence

Spec approval: not obtained (autonomous run). The user explicitly requested nullable
fields and confirmed contract forms only. Tier 3 checks address contract/PDF integrity,
partial equipment selection, default link expiry and preserved Setup/signing rules.
The specification is `test/mbr/nullable-spec.md`. No dependencies, commits or schema
migration were added; historical contract snapshots and signed PDF blobs were retained.

Source hash: `{state}`. Runtime image: `{prepared['image']}`.
Reproduce with `python3 server/tools/mbr-nullable-gauntlet.py candidate` using the
prepared image and existing repository test/browser caches. Workspace checks can be
run with `python3 server/tools/mbr-nullable-gauntlet.py all`.

| Layer | Final result |
| --- | --- |
| Complete MBR backend/equipment/nullable suite | {checks['tests']['pass']} passed, {checks['tests']['fail']} failed |
| Reverse file-order suite | {checks['shuffled-tests']['pass']} passed, {checks['shuffled-tests']['fail']} failed |
| New Chromium/WebKit empty-contract flows | {len(browser)} passed |
| Existing equipment/card/phone/desktop flows | {len(equipment_browser)} passed |
| Existing signing/renewal/PDF phone flows | {len(legacy_browser)} passed |
| Types/lint | Strict shared-domain types and MBR JS lint/complexity passed |
| Changed executable backend/shared lines | {changed_covered}/{changed_total} covered |
| Measured backend/shared total | {total['lines']['covered']}/{total['lines']['total']} lines; {total['branches']['covered']}/{total['branches']['total']} branches |
| Deliberate mutants | {sum(row['killed'] for row in mutants)}/{len(mutants)} killed; missing-rate-to-zero also killed by properties alone |
| Secrets/dependencies | Zero runtime-delta secret findings; no dependency changes |
| Cleanup/resources | Standard bounded Compose, mbbs-tests.slice and finally teardown; no task containers/networks/volumes; ps and ps -a verified; production health passed |

Spec mapping:

- Omitted/null/empty/whitespace fields and clearing each field: `nullable.test.js`;
  160 seeded arbitrary-subset property cases preserve all other populated values.
- Date validation, partial period display, amounts and genuine zero amounts:
  nullable tests plus all existing domain/money/date properties.
- Empty save/reopen/list/edit/refill/model-only choices: `nullable-http.test.js` and
  Chromium/WebKit form tests; client controls contain zero required attributes.
- Clean agreement and PDF blanks: unit template/summary checks and real downloaded
  PDF content; no null/undefined text or fabricated zero amounts.
- Three-day default while expiry stays null: HTTP and browser issue/edit/renew tests.
- Setup and customer signing remain strict: explicit Setup-null rejection and the
  full existing equipment, consent, signature, revision, role and immutable-PDF suites.
- Live change isolation: source deltas are merged onto the current live image,
  with candidate hashes, configuration guards, an unchanged worker and app rollback.

Observed RED: eight new requirements failed on the original implementation; one
pre-existing strict-validation test already passed. Core and candidate runs then
passed after implementation. Tooling fixes removed a test variable shadowing an
import and removed an unnecessary migration COPY from this schema-free image build.
All test stacks were removed after success/failure and health was checked.

Limits: UI/CSS are checked through real browsers, accessibility and viewport checks;
no numeric frontend line coverage is claimed. Types cover shared core modules, while
SQL/browser behavior is exercised by tests and lint. Shared server/navigation files
were not edited, so unrelated Field Sales regressions were not repeated; the previous
release documented its existing staff-redirect baseline failure. Dependency audit was
not repeated because dependencies did not change. These checks cover the specification
and do not claim exhaustive proof.
'''
(OUT / 'EVIDENCE.md').write_text(report)
print(json.dumps({'evidence': str(OUT / 'EVIDENCE.md'), 'tests': checks['tests']['pass'],
                  'browserFlows': len(browser) + len(legacy_browser) + len(equipment_browser), 'mutantsKilled': len(mutants),
                  'changedLinesCovered': changed_covered, 'changedLinesMeasured': changed_total}))
