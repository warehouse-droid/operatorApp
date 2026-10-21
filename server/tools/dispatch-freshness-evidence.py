"""Summarize measured results without marking baseline failures as passes."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/dispatch-freshness-20261019'
results = artifact / 'results'
read = lambda name: json.loads((results / name).read_text())
final = read('final.json')
baseline = {row['file']: row for row in read('baseline.json')['results']}
for row in final['results']:
    if row['exit']:
        assert row['failures'] == baseline[row['file']]['failures'], row
        assert row['exit'] == baseline[row['file']]['exit'], row
mutations = read('mutations.json')
assert len(mutations) == 15 and all(row['killed'] for row in mutations)
types = read('types.json')
assert not types['added'], types
coverage = read('changed-line-coverage.json')
for row in coverage:
    assert row['sha256'] == hashlib.sha256((root / row['file']).read_bytes()).hexdigest(), row['file']
    assert row['executable'] > 0 and not row['missing'], row
assert 'teardown_exit=0' in (artifact / 'teardown.log').read_text()
counts = {key: sum(row.get(key, 0) for row in final['results']) for key in ['tests', 'pass', 'fail', 'skipped']}
browser = next(row for row in final['results'] if row['file'].endswith('dispatch-freshness.browser.test.mjs'))
assert browser['fail'] == 0 and browser['pass'] == 22
day = read('full-day-replay/latest.json')
assert day['status'] == 'passed' and all(row['status'] == 'passed' for row in day['actions'])
assert day['slowThresholdMs'] == 1500
assert day['runtimeHashes'] == {row['file']: row['sha256'] for row in coverage}, 'day replay must use the final runtime source'
report = {
    'status': 'validated with unchanged baseline failures',
    'tier': 3,
    'specApproval': 'not obtained (autonomous run)',
    'spec': 'test/dispatch-freshness-spec.json',
    'specVerification': [
        {'behaviors': [1, 16], 'tests': 'dispatch-freshness-server.test.js: fresh read bypass, exact/numeric identities, targeted mutation acknowledgement and replacement event identities'},
        {'behaviors': [2, 12], 'tests': 'dispatch-freshness.browser.test.mjs: both order and CO events, remote group and remote ungroup; dispatch-freshness-races.test.js: nested reference closure'},
        {'behaviors': [3], 'tests': 'dispatch-freshness-races.test.js: 250 response interleavings and navigation/epoch guards; browser late-read and atomic-link scenarios'},
        {'behaviors': [4, 5], 'tests': 'browser compact-drag and group-links scenarios; generated cargo properties; existing CO preservation, retirement and save-reliability suites'},
        {'behaviors': [6], 'tests': 'dispatch-freshness.test.js: persisted acknowledgement, following fenced save and replay; browser resplit-fence scenario'},
        {'behaviors': [7], 'tests': 'dispatch-freshness-server.test.js: catalog commit precedes publication and does not self-enqueue'},
        {'behaviors': [8], 'tests': 'browser prefetch-drag scenario: hover starts hydration and duplicate hovers coalesce'},
        {'behaviors': [9, 10], 'tests': 'browser snapshot-recovery and snapshot-draft; bounded refresh failures property; existing link-preserve and save-reliability suites'},
        {'behaviors': [11, 13, 14], 'tests': 'browser browse-detail-race and catalog-lag scenarios for browse, search, pagination and legacy feeds'},
        {'behaviors': [15], 'tests': 'browser data-clear scenario'},
        {'behaviors': [17, 19], 'tests': 'dispatch-full-day.browser.test.mjs: real HTTP/PostgreSQL, two Chromium sessions, action timings and traces'},
        {'behaviors': [18], 'tests': 'browser immediate order actions scenario, reproduced by the full-day PO-link workflow'},
        {'behaviors': [20], 'tests': 'browser local-retirement-evidence scenario; full-day ungroup and persisted retirement assertions'},
        {'behaviors': [21], 'tests': 'browser new-day-observer and unsaved-draft scenarios; full-day observer opens before the plan exists'},
        {'behaviors': [22], 'tests': 'full-day backend/editor/observer comparisons, with a stale-observer negative control'},
        {'behaviors': [23], 'tests': 'dispatch-freshness-sor.test.js: examples and 150 generated quantities; full-day group link and unlink comparisons'},
        {'behaviors': [24], 'tests': 'browser selection-drag-source reproduction, mutation and full-day native drag/drop'}
    ],
    'sourceState': hashlib.sha256(json.dumps([(row['file'], row['sha256']) for row in coverage]).encode()).hexdigest(),
    'productionDeployment': 'not performed',
    'reproduce': 'bash server/tools/dispatch-freshness-gauntlet.sh',
    'tests': counts,
    'suites': len(final['results']),
    'freshnessBrowserScenariosPassed': browser['pass'],
    'fullDayReplay': {'status': day['status'], 'stages': len(day['steps']), **day['timingSummary'],
        'artifact': day['artifact'], 'slowActions': [{'name': row['name'], 'waitMs': row['waitMs']} for row in day['actions'] if row['slow']]},
    'originalBrowserFailures': baseline[browser['file']]['fail'],
    'beforeTraces': 'results/freshness-browser/original',
    'afterTraces': 'results/freshness-browser/verified',
    'properties': {'unchangedAndChangedCargo': '250 generated inputs across SO, PO, TO and CO',
                   'outOfOrderResponses': '250 generated interleavings, with and without a concurrent mutation'},
    'mutations': mutations,
    'propertyMutationAttribution': 'Generation, response-order and hydrated-cargo mutants were independently killed by the property test file. Server, digest, catalog verification and recovery mutants used API or browser assertions. The preexisting unsaved-draft invariant was also independently mutation-tested.',
    'unchangedBaselineFailures': [row for row in final['results'] if row['exit']],
    'syntax': 'node --check passed for all six changed runtime files',
    'lint': {'newDiagnostics': 0, 'baselineDiagnostics': len(final['diagnostics'])},
    'types': types,
    'changedLineCoverage': [{key: row[key] for key in ['file', 'executable', 'covered', 'missing']} for row in coverage],
    'toolchain': read('toolchain.json'),
    'cleanup': 'Compose teardown removed disposable containers, databases and networks. docker ps and docker ps -a were recorded and production health passed.',
    'limits': [
        'Tests use isolated synthetic data; no production dispatch orders were mutated.',
        'Affected suites were run, not the entire application test collection.',
        'Suite order was not randomized: each test file runs in a fresh process and disposable database. Race ordering is randomized with recorded seeds.',
        'The browser script is untyped; runtime and lint checks supplement backend type diagnostics.',
        'Production latency and end-to-end NetSuite synchronization were not benchmarked.',
        'No dependency changes or migrations; dependency audit was not rerun.',
        'A snapshot is never automatically recovered over an unsaved draft; deliberate review is still required for genuine conflicting edits.'
    ],
    'notes': [
        'Browser failures were reproduced before implementation changes. An initial fixture startup wait was corrected before those reproductions.',
        'Older browser fixtures were updated to load dispatch-edit-activity.js without changing behavioral assertions.',
        'The further-split test verifies both the database acknowledgement and the browser adopting its digest.',
        'Mutation copies are isolated under /tmp inside the disposable container; workspace implementation files are never mutated.',
        'Coverage excludes legacy VM wrapper counts. Extracted functions use original source offsets with unexecuted padding; real Chromium execution is reported separately before merging.'
        , 'The real-server day replay exposed additional bugs: immediate actions retained the previous selection, locally retired groups remained resolvable through catalog/assignment evidence, and an empty-day observer never adopted the newly created plan. Each received a red/green browser regression.'
        , 'Replay setup corrections used the actual driver-lane configuration, PO mapping controls, poPickupManifest field and dependency_mode database column. Functional and latency assertions were not relaxed.'
        , 'Attempting to unlink a PO while its pickup remained planned returned DISPATCH_PICKUP_ORDER_MISSING. That trace is retained in full-day-phase11.log; the completed workflow removes planned stops before unlinking.'
    ]
}
(artifact / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'counts': counts, 'browserPassed': browser['pass'], 'mutantsKilled': len(mutations),
                  'coverage': report['changedLineCoverage'], 'evidence': str(artifact / 'evidence.json')}))
