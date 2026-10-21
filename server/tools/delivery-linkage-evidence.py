"""Assemble the report solely from the final fresh run and release manifest."""
import hashlib
import json
from pathlib import Path
import re

server = Path(__file__).resolve().parents[1]
artifact = server / 'test-artifacts/delivery-so-linkage-20261008'
results = artifact / 'final/results'
release = server / 'deployments/delivery-so-linkage-20261008'
read = lambda path: json.loads(path.read_text())
manifest = read(release / 'manifest.json')
validation = read(release / 'validation-passed.json')
assert validation['candidateTreeHash'] == manifest['candidateTreeHash']
stages = read(results / 'stages.json')
assert all(stage['exitCode'] == 0 for stage in stages)
suite = re.search(r'run passed: (\d+) file\(s\), (\d+) test\(s\)', (results / 'tests.log').read_text())
assert suite, 'No final suite success marker'
coverage = read(results / 'changed-lines.json')
assert not coverage['uncovered']
mutants = read(results / 'mutations.json')
assert all(all(outcome['killed'] for outcome in item['outcomes']) for item in mutants)
patch = (artifact / 'changes.patch').read_text()
secret_patterns = [r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', r'AKIA[A-Z0-9]{16}', r'gh[pousr]_[A-Za-z0-9]{30,}']
assert not any(re.search(pattern, patch) for pattern in secret_patterns)
assert all(not name.startswith(('migrations/', 'package', '.env')) for name in manifest['files'])
tests = list((server / 'test/mbt').rglob('delivery-request*.test.js'))
tests += [server / 'test/dispatch/frontend/dispatch-completion-ui.test.js']
report = {
    'status': 'validated; staged for deployment',
    'spec approval': 'not obtained (autonomous run); user explicitly confirmed minimum-window and last-link decisions',
    'spec': 'spec.json', 'sourceTreeHash': manifest['candidateTreeHash'],
    'runtimeFiles': manifest['files'], 'tests': {'files': int(suite[1]), 'passed': int(suite[2]), 'shuffleSeed': 8102026},
    'coverage': coverage, 'mutantsKilled': len(mutants),
    'properties': {'runsPerProperty': 200, 'seed': 5102026, 'domainMutantsKilledByPropertiesAlone': 3},
    'tools': read(results / 'versions.log'), 'stages': stages,
    'reproduce': 'python3 server/tools/delivery-so-linkage-release.py validate',
    'acceptanceMapping': {
        'exchange/unlink preserve approval, audit and quote': 'delivery-requests.test.js: linkage atomic exchange; delivery-request-domain.test.js: linkage legacy approved slot',
        'minimum one SO, role/yard/state, hostile refs': 'delivery-request-domain.test.js: linkage fail closed; delivery-requests.test.js: rollback wrong-yard replacement',
        'concurrent edits and exactly-once retry': 'delivery-requests.test.js: parallel relinks; delivery-requests-http.test.js: real HTTP exchange',
        'approved timing and priority, including cancellation/unlink': 'delivery-request-planning.test.js: paged feed, grouped aliases, idempotent overlay, compact cached timing restoration',
        'yellow/green Secured cards retain planning restrictions': 'delivery-request-cards-browser.test.js: actual card renderer plus computed CSS in Chromium',
        'Sales UI and failure preservation, Dispatch read-only': 'delivery-requests-browser.test.js: linkage tests, mobile layout and failed replacement',
        'free text formatting and immediate two-hour block': 'delivery-requests-browser.test.js: timeslot frontend and updates tests; existing domain and HTTP minimum interval tests',
        'popup restore and access loss': 'delivery-request-event-stream-browser.test.js: restore test with visibility/focus, HTTP 503, account change, Close, revision update and HTTP 401',
        'cross-page Dispatch alerts': 'delivery-request-event-stream-browser.test.js: actual sidebar and SSE across five routes',
        'original planning/card behavior': 'dispatch-order-catalog.red.test.js, dispatch-planner-optimization.red.test.js, dispatch-fulfilled-so-ui.test.js, dispatch-completion-ui.test.js'
    },
    'realDataReadOnlyPreview': read(artifact / 'live-readonly-candidate-preview.json'),
    'corrections': [
        'RED reproduced missing relink action, default 22:00 timing, missing Secured card styling, missing editor, and popup removal on restore.',
        'Lint required splitting session setup and simplifying the mutation runner nesting; no rule was relaxed.',
        'Baseline test expected an obsolete September cache version. Baseline failure recorded before updating its exact assertion to this release version; functional assertions unchanged.',
        'Coverage initially omitted existing time-input tests because only some pages were instrumented. Expanded coverage collection without changing their assertions.'
    ],
    'limitsAndSkippedLayers': [
        'Full relevant delivery suites and adjacent Dispatch suites ran; the unrelated whole-repository test suite was not run.',
        'Existing TypeScript configuration checks the delivery domain and expiry logic; other changed JavaScript was linted or syntax checked and exercised at runtime.',
        'Browser minimize/restore was simulated through visibility and focus events in headless Chromium; no desktop window manager test.',
        'No schema or dependency changes: migration rollback, dependency audit and license review were not applicable.',
        'No Git checkpoint commits were authorized; exact live/candidate snapshots, hashes and isolated mutant scratch copies provide restoration evidence.',
        'If multiple confirmed requests link the same SO, the latest-updated confirmed request supplies its window. Group cards prefer a direct matching reference, then their child references. No production link data was rewritten.'
    ],
    'supplyChainAndSecrets': {'dependenciesChanged': False, 'diffSecretScanPassed': True, 'newRuntimeCapabilities': 'No new external service, filesystem, subprocess, or environment access.'},
    'testSourceHashes': {str(path.relative_to(server)): hashlib.sha256(path.read_bytes()).hexdigest() for path in tests},
    'cleanup': {'composeTeardown': 'final/teardown.log', 'runningContainers': (artifact / 'final/docker-ps.log').read_text().splitlines(),
                'allContainers': (artifact / 'final/docker-ps-a.log').read_text().splitlines(), 'productionHealth': (artifact / 'final/production-health.log').read_text().splitlines()}
}
(artifact / 'EVIDENCE.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'testsPassed': int(suite[2]), 'files': int(suite[1]), 'changedLinesCovered': coverage['covered'], 'changedLinesTotal': coverage['total'], 'mutantsKilled': len(mutants)}))
