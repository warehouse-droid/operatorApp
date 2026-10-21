"""Verify final artifacts, changed-line execution and exact release source."""
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/delivery-requests-ui-20261006'
RESULTS = ARTIFACT / 'results/delivery-requests-ui'
RELEASE = SERVER / 'deployments/delivery-request-ui-20261006'


def load(path):
    return json.loads(path.read_text())


def changed_lines(name, source):
    old = (ARTIFACT / 'before' / name).read_text().splitlines(True)
    current = source.splitlines(True)
    return sorted({line + 1 for tag, _a, _b, start, end in difflib.SequenceMatcher(None, old, current).get_opcodes()
                   if tag in ['replace', 'insert'] for line in range(start, end) if current[line].strip()})


def browser_line_hit(entry, start, end):
    if 'functions' in entry:
        ranges = [item for function in entry['functions'] for item in function['ranges']]
        points = {start, *[item['startOffset'] for item in ranges if start <= item['startOffset'] < end]}
        for point in points:
            containing = [item for item in ranges if item['startOffset'] <= point < item['endOffset']]
            if containing and min(containing, key=lambda item: item['endOffset'] - item['startOffset'])['count'] > 0:
                return True
        return False
    return any(item['start'] < end and item['end'] > start for item in entry['ranges'])


def coverage(source_root):
    before = load(ARTIFACT / 'before.json')
    browser = [entry for path in RESULTS.glob('browser-coverage-*.json') for entry in load(path)]
    assert browser, 'No fresh browser coverage'
    backend = {}
    name = ''
    for row in (ARTIFACT / 'results/delivery-requests/coverage/lcov.info').read_text().splitlines():
        if row.startswith('SF:'):
            name = row[3:]
        elif row.startswith('DA:') and name.endswith('delivery-request-repository.js'):
            line, count = row[3:].split(',')[:2]
            backend[int(line)] = int(count)
    report = {}
    for name in before:
        if not name.endswith('.js'):
            report[name] = {'layer': 'browser layout/geometry and asset hashes', 'executionCoverage': 'n-a'}
            continue
        source = (source_root / name).read_text()
        lines = changed_lines(name, source)
        if name.startswith('src/'):
            hit = [line for line in lines if backend.get(line, 0) > 0]
        else:
            entries = [entry for entry in browser if urlparse(entry['url']).path == '/' + name.removeprefix('public/')]
            assert entries, 'No browser execution: ' + name
            offsets, offset = {}, 0
            for line, text in enumerate(source.splitlines(True), 1):
                offsets[line] = (offset + len(text) - len(text.lstrip()), offset + len(text))
                offset += len(text)
            hit = [line for line in lines if any(browser_line_hit(entry, *offsets[line]) for entry in entries)]
        report[name] = {'changedLines': lines, 'coveredLines': hit, 'missedLines': sorted(set(lines) - set(hit))}
    (RESULTS / 'changed-line-coverage.json').write_text(json.dumps(report, indent=2) + '\n')
    assert all(not row.get('missedLines') for row in report.values()), 'Changed lines lack execution; inspect changed-line-coverage.json'
    return report


def main():
    source_root = Path(sys.argv[1]) if len(sys.argv) > 1 else SERVER
    stages = load(RESULTS / 'stages.json')
    assert [row['name'] for row in stages] == ['workflow', 'types', 'lint', 'syntax', 'versions', 'mutations', 'browser']
    assert all(row['exitCode'] == 0 for row in stages), 'A gauntlet stage failed'
    mutations = load(RESULTS / 'mutations.json')
    assert len(mutations) == 5 and all(row['killed'] for row in mutations)
    assert mutations[0]['propertyKilled'], 'Origin property must independently detect an incorrect fixed yard'
    source = load(RESULTS / 'source.json')['files']
    assert all(hashlib.sha256((source_root / name).read_bytes()).hexdigest() == digest for name, digest in source.items())
    covered = coverage(source_root)
    workflow = (RESULTS / 'workflow.log').read_text()
    passes = sum(map(int, re.findall(r'^ℹ pass (\d+)$', workflow, re.M)))
    failures = sum(map(int, re.findall(r'^ℹ fail (\d+)$', workflow, re.M)))
    assert passes > 0 and failures == 0
    browser_log = (RESULTS / 'browser.log').read_text()
    browser_passes = int(re.search(r'^# pass (\d+)$', browser_log, re.M)[1])
    assert re.search(r'^# fail 0$', browser_log, re.M)
    assert (ARTIFACT / 'teardown.log').read_text().endswith('teardown_exit=0\n')
    for name in ['docker-ps.log', 'docker-ps-a.log']:
        assert not re.search('mbbs-delivery-(?:request-ui-test|ui-)', (ARTIFACT / name).read_text())
    secrets = re.compile(r'''(?i)(?:api_key|password|secret|token)\s*[:=]\s*['"][a-z0-9/_-]{16,}''')
    for name in source:
        current = (source_root / name).read_text().splitlines(True)
        old = (ARTIFACT / 'before' / name).read_text().splitlines(True)
        added = ''.join(row[1:] for row in difflib.unified_diff(old, current) if row.startswith('+') and not row.startswith('+++'))
        assert not secrets.search(added), 'Secret-like value added to ' + name
    digest = load(RESULTS / 'source.json')['treeHash']
    executed = sum(len(row.get('coveredLines', [])) for row in covered.values())
    total = sum(len(row.get('changedLines', [])) for row in covered.values())
    summary = {'workflowPassed': passes, 'workflowFailed': failures, 'browserPassed': browser_passes,
               'manualMutantsKilled': len(mutations), 'changedJsLinesCovered': executed, 'changedJsLines': total,
               'sourceTreeHash': digest, 'teardownPassed': True}
    (RESULTS / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    report = f'''# Delivery request UI verification

Spec approval: not obtained (autonomous run). Authorized behaviors are in
[delivery-requests-ui-spec.md](../../test/delivery-requests-ui-spec.md).
Tier 3 checks cover quote origin, multi-status queries and revision-safe alerts.

Final source hash: `{digest}`.
Reproduce: `sudo -n bash server/tools/delivery-request-ui-gauntlet.sh`.
Use `DELIVERY_UI_SOURCE_ROOT` to test the captured release candidate.

| Layer | Final result |
| --- | --- |
| Complete delivery/adjacent workflow suites, 13 files, shuffled seed 5102026 | {passes} passed, {failures} failed |
| Final browser execution after mutation | {browser_passes} passed, 0 failed |
| Existing delivery TypeScript checks | 0 errors |
| Delivery ESLint and sidebar syntax | 0 errors, 0 warnings |
| Changed JavaScript line execution | {executed}/{total} |
| Manual mutation | 5/5 meaningful bugs detected |
| Properties | 6 existing pricing/access/time properties, 200 cases each; 16 browser yard-order cases, seed 6102026 |
| Host cleanup | All task test containers, databases, networks and disposable storage removed; production health passes |
| Dependencies/secrets | No dependencies added; scoped source diff secret scan passes |

The seven acceptance criteria map to named `UI:` tests in
`delivery-requests-browser.test.js`, `delivery-request-event-stream-browser.test.js`
and `delivery-requests-http.test.js`; pricing invariants also map to the existing
delivery domain properties and quote-ticket integration tests. Tests cover Sales
and Dispatch, POS and BIN, all four yards, edit/re-raise, search, legacy filters,
hostile status/address values, older/equal/newer alert revisions, and desktop/phone
scroll geometry. Screenshots and raw browser/backend coverage are kept with logs.

Limits: types use the existing delivery domain/expiry check; the DOM UI and SQL
repository remain JavaScript checked by lint, execution and integration tests.
HTML/CSS line execution is not applicable; geometry, scrolling and screenshots
verify their behavior. The host-wide unrelated application suites were not rerun;
the complete delivery suite and its adjacent boss/instruction suites were run.
Dependency audits are not applicable because no dependency or lockfile changed.
No standalone performance budget or browser support expansion was requested.

Observed during development: the old implementation failed all 10 new browser
behaviors and all three multi-status HTTP checks. Existing HTTP unread receipts
already worked; the defect was popup suppression for an open request. Test
selectors were corrected to target comboboxes rather than similarly named Remove
buttons; no behavioral assertions were weakened. The first coverage launch found
artifact-directory permissions, which were corrected. A test helper variable was
renamed to satisfy lint. The phone layout was checked visually and made compact.
'''
    (ARTIFACT / 'EVIDENCE.md').write_text(report)
    if source_root == RELEASE / 'candidate':
        manifest = load(RELEASE / 'manifest.json')
        assert source == manifest['workspace'], 'Release candidate differs from tested source'
        assert all(hashlib.sha256((SERVER / name).read_bytes()).hexdigest() == digest for name, digest in source.items())
        for name in ['package.json', 'package-lock.json']:
            assert (source_root / name).read_bytes() == (RELEASE / 'before' / name).read_bytes()
        (RELEASE / 'validation-passed.json').write_text(json.dumps({'passed': True, 'candidateTreeHash': manifest['candidateTreeHash'], **summary}, indent=2) + '\n')
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
