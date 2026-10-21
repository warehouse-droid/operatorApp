#!/usr/bin/env python3
"""Build the MBR equipment evidence report from completed candidate checks."""
import difflib
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/mbr-equipment'
RELEASE = SERVER / 'deployments/mbr-equipment-20261013'
checks = json.loads((OUT / 'checks.candidate.json').read_text())['results']
validation = json.loads((OUT / 'validation.candidate.json').read_text())
prepared = json.loads((OUT / 'prepared.json').read_text())
cleanup = json.loads((OUT / 'cleanup.candidate.json').read_text())
assert validation['passed'] and validation['cleanupVerified']
assert not any(cleanup[key] for key in ('containers', 'networks', 'volumes'))
assert cleanup['teardownExit'] == 0
assert not checks['shared-regressions']['newFailures']
for name, record in checks.items():
    if name != 'shared-regressions':
        assert record['exit'] == 0, name
coverage = json.loads((OUT / 'coverage-candidate/coverage-summary.json').read_text())
map_data = json.loads((OUT / 'coverage-candidate/coverage-final.json').read_text())
mutants = json.loads((OUT / 'mutations/results.json').read_text())
browser = json.loads((OUT / 'browser/results.json').read_text())
legacy_browser = json.loads((OUT / 'contract-browser/results.json').read_text())
assert all(row['killed'] for row in mutants)
assert all(row['status'] == 'passed' for row in browser + legacy_browser)
state = hashlib.sha256(json.dumps(prepared['sourceHashes'], sort_keys=True).encode()).hexdigest()
changed = {}
for name in ['src/mbr/equipment-repository.js', 'src/mbr/repository.js', 'src/mbr/router.js', 'src/mbr/pdf.js', 'public/mbr/equipment.js']:
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
report = f'''# MBR Setup and contract card downloads — evidence

Spec approval: not obtained (autonomous run). Work was authorized by the user's
equipment roster and follow-ups; ATL1000 was explicitly confirmed. The append-only
acceptance specification is in `test/mbr/equipment-spec.md`. Tier 3 validation was
chosen for contract integrity, setup write authorization, concurrent edits and
signed-document preservation. No dependencies or automatic commits were added.

Candidate image: `{prepared['image']}`. Runtime source hash: `{state}`.
Per-file hashes, original live files, production delta and rollback configuration
are retained in this artifact directory and `deployments/mbr-equipment-20261013`.

Reproduce checks with `python3 server/tools/mbr-equipment-gauntlet.py candidate`
(the prepared image and repository's existing test/browser caches are required).
`python3 server/tools/mbr-equipment-gauntlet.py all` tests workspace sources using
the same existing bounded test image. Release preparation and deployment are
separate commands in `tools/mbr-equipment-release.py`; validation never deploys.

| Validation layer | Final observed result |
| --- | --- |
| MBR domain, security, repository, HTTP, runtime, equipment and property suite | {checks['tests']['pass']} passed, {checks['tests']['fail']} failed |
| Same suite in reverse file order | {checks['shuffled-tests']['pass']} passed, {checks['shuffled-tests']['fail']} failed |
| Shared login/navigation/Field Sales regressions | {checks['shared-regressions']['pass']} passed; {checks['shared-regressions']['fail']} known baseline failure; zero new failures |
| Chromium 375 px / 1280 px and WebKit 390 px equipment/card flows | {len(browser)} passed |
| Existing customer signing, renewal, PDF and phone flows | {len(legacy_browser)} passed |
| Types | Strict check of shared contract/equipment modules passed |
| Lint/complexity | MBR source, frontend, tests and JS validation tools passed |
| Changed executable backend/shared lines | {changed_covered}/{changed_total} covered |
| Full measured MBR backend/shared coverage | {total['lines']['covered']}/{total['lines']['total']} lines; {total['branches']['covered']}/{total['branches']['total']} branches |
| Deliberate mutants | {sum(row['killed'] for row in mutants)}/{len(mutants)} killed; all four equipment invariants also killed by property tests alone |
| Accessibility and real execution | Browser accessibility assertions, page-width checks, real HTTP, persisted SQL and actual downloaded PDF bytes/text passed |
| Secrets/supply chain | Runtime delta scan found zero secrets; dependencies unchanged |
| Cleanup/host policy | Finally teardown, bounded standard Compose and mbbs-tests.slice verified; no task containers, volumes or networks; ps and ps -a recorded; live health passed |

Acceptance mapping:

- Exact 38-unit/12-model roster and transactional migration rollback:
  `equipment-http.test.js` and every-model browser checks against the user roster.
- Authorized setup persistence, duplicate identifiers, inactive availability,
  storage errors and concurrent/stale edits: `equipment-http.test.js`; actual
  add/edit/deactivation, duplicate errors, search and cancel are exercised in browsers.
- Sound and complete model/SN filtering: `equipment.test.js`, 120 seeded catalog
  property cases and all-model browser assertions; changing model clears SN.
- Historical values and deactivated equipment: HTTP and browser tests preserve
  old selections while refusing invalid new selections or changed associations.
- Card downloads and unsaved editor changes: browser tests download the correct
  card without navigation and require saving before an editor download.
- Unsigned saved terms, edited terms and expiry: actual PDF content assertions;
  no signature/completion is fabricated. Customer draft downloads still return 409.
- Signed documents: completed card bytes equal the customer's stored signed PDF;
  existing MBR signature/PDF, stale-revision, expiry and renewal suites pass.

Observed RED: all 12 initial new tests failed on the prior behavior. Browser checks
then exposed dropdown accessible-label ambiguity; explicit label references fixed
it without weakening assertions. Tooling repairs included restricting coverage
scans to MBR source, dereferencing source copies for temporary mutants, and exposing
existing RESTlet fixtures to the shared runner. Every failed/interrupted stack was
removed; its cleanup logs and production health evidence were retained.

Limits: the known staff-module redirect failure remains exactly as in the preserved
baseline. Backend/shared line coverage is measured separately from recorded browser
V8 coverage; no numeric frontend line-coverage claim is made. CSS is checked through
real viewport/accessibility checks. Static types cover shared core modules; dynamic
SQL and browser code are checked by lint, real execution and tests. A dependency
audit was unnecessary because no dependency changed. These checks express the
acceptance specification and do not claim exhaustive proof.
'''
(OUT / 'EVIDENCE.md').write_text(report)
print(json.dumps({'evidence': str(OUT / 'EVIDENCE.md'), 'tests': checks['tests']['pass'],
                  'browserFlows': len(browser) + len(legacy_browser), 'mutantsKilled': len(mutants),
                  'changedLinesCovered': changed_covered, 'changedLinesMeasured': changed_total}))
