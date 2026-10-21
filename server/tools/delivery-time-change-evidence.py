"""Assemble evidence for the exact combined candidate without changing live data."""
import hashlib
import json
from pathlib import Path
import re

server = Path(__file__).resolve().parents[1]
artifact = server / 'test-artifacts/delivery-time-change-20261008'
release = server / 'deployments/delivery-time-change-20261008'
read = lambda path: json.loads(path.read_text())
manifest = read(release / 'manifest.json')
validation = read(release / 'validation-passed.json')
image = read(release / 'image-check.json')
assert validation['passed'] and validation['candidateTreeHash'] == manifest['candidateTreeHash']
assert image['passed'] and image['imageId'] == manifest['candidateImageId']
assert all(hashlib.sha256((server / name).read_bytes()).hexdigest() == value
           for name, value in manifest['workspace'].items())
assert all(not name.startswith(('migrations/', 'package', '.env')) for name in manifest['files'])
groups = {}
for group in ['delivery', 'po-sales']:
    results = artifact / group / 'results'
    stages = read(results / 'stages.json')
    assert all(stage['exitCode'] == 0 for stage in stages)
    suite = re.search(r'run passed: (\d+) file\(s\), (\d+) test\(s\)', (results / 'tests.log').read_text())
    assert suite, 'Missing final passing suite count'
    coverage = read(results / 'changed-lines.json')
    assert not coverage['uncovered'] and coverage['covered'] == coverage['total']
    mutants = read(results / 'mutations.json')
    if group == 'delivery':
        mutants += read(results / 'time-change-mutations.json')
    assert all(item['restored'] and
               (all(outcome['killed'] for outcome in item['outcomes']) if 'outcomes' in item else item['killed'])
               for item in mutants)
    patch = (artifact / group / 'changes.patch').read_text()
    patterns = [r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', r'AKIA[A-Z0-9]{16}', r'gh[pousr]_[A-Za-z0-9]{30,}']
    assert not any(re.search(pattern, patch) for pattern in patterns)
    groups[group] = {
        'tests': {'files': int(suite[1]), 'passed': int(suite[2])},
        'coverage': coverage, 'mutants': mutants,
        'tools': read(results / 'versions.log'), 'stages': stages,
        'sourceHashes': read(results / 'source-hashes.json'),
        'cleanup': {
            'teardownLog': group + '/teardown.log',
            'runningContainers': (artifact / group / 'docker-ps.log').read_text().splitlines(),
            'allContainers': (artifact / group / 'docker-ps-a.log').read_text().splitlines(),
            'productionHealth': (artifact / group / 'production-health.log').read_text().splitlines()
        }
    }
prior = read(server / 'test-artifacts/delivery-so-linkage-20261008/EVIDENCE.json')
test_paths = list(prior['testSourceHashes']) + [
    'test/mbt/unit/special-po-reference.test.js',
    'test/mbt/integration/special-po-reference-http.test.js',
    'test/mbt/integration/special-po-reference-browser.test.js',
    'test/mbt/integration/special-sales-alert-browser.test.js'
]
preview = read(server / 'test-artifacts/special-po-sales-alert-20261008/live-readonly-preview.json')
assert preview['sourceHash'] == manifest['candidateTree']['src/special-po-reference-alerts.js']
report = {
    'status': 'validated and built; awaiting fresh deployment approval',
    'spec approval': 'not obtained (autonomous run); user decisions and final Queued condition recorded in specs',
    'specs': ['spec.json', '../delivery-so-linkage-20261008/spec.json', '../special-po-sales-alert-20261008/spec.json'],
    'candidateTreeHash': manifest['candidateTreeHash'], 'image': image,
    'runtimeFiles': manifest['files'], 'runtimeSourceHashes': {
        name: manifest['candidateTree'][name] for name in manifest['files']
    },
    'totals': {
        'testFiles': sum(group['tests']['files'] for group in groups.values()),
        'testsPassed': sum(group['tests']['passed'] for group in groups.values()),
        'changedExecutableLinesCovered': sum(group['coverage']['covered'] for group in groups.values()),
        'changedExecutableLinesTotal': sum(group['coverage']['total'] for group in groups.values()),
        'mutantsKilled': sum(len(group['mutants']) for group in groups.values())
    },
    'groups': groups,
    'reproduce': 'python3 server/tools/delivery-time-change-release.py validate',
    'acceptanceMapping': {
        **prior['acceptanceMapping'],
        'secured requests can request, replace and withdraw a timeslot': 'delivery-request-domain.test.js and delivery-requests-browser.test.js: time change scenarios; exact old-slot/link/quote/clock preservation',
        'only Dispatch acceptance changes active scheduling': 'delivery-requests.test.js: pending planning retains approved legacy time until acceptance, including cached card overlay; HTTP role and yard guards',
        'decline and withdrawal retain existing approval': 'delivery-request-domain.test.js, property suite, HTTP and browser time change scenarios',
        'two-hour minimum applies to new slots': 'domain invalid-window cases; property verifies 120 accepted/119 rejected; browser typing 0800 to 0830 warns and blocks then reformats valid input',
        'cancel releases all SOs for another request': 'delivery-requests.test.js: association deletion, cached planning restoration, same SO linked to new request and audit refs; real HTTP and UI cancellation',
        'no partial writes, stale acceptance or double event': 'delivery-requests.test.js: acceptance/cancel rollback, idempotent replay, simultaneous accept/decline and accept/cancel with exactly one winner',
        'new actions alert across pages': 'delivery-requests-browser.test.js: global notifications for request, acceptance, decline, withdrawal and cancellation; real repository durable alert rows',
        'Sales owner alerted for all three fulfillment methods': 'special-po-reference.test.js: Sales delivery alert property (200 runs, seed 8102026); special-po-reference-http.test.js: committed SCM refs',
        'existing reference AND Queued required': 'special-po-reference-http.test.js: authoritative Queued status across all three methods; Hold, Planned, Completed, Cancelled and empty ref excluded',
        'Dispatch and Sales acknowledge independently': 'special-po-reference-http.test.js: Dispatch acknowledgement preserves Sales notice, including same operator with both audiences',
        'owner, yard and private Sales access remain mandatory': 'special-po-reference-http.test.js: real HTTP list and acknowledgement authorization; same owner without assigned yard denied',
        'existing active SPREQ-000043 alerts without data rewrite': 'live-readonly-preview.json: exact candidate SELECT-only projection for its existing owner and yard',
        'reference and method changes re-alert; stale retries stay safe': 'special-po-reference-http.test.js: ref/method changes, stale acknowledgement, concurrent duplicate and rollback tests',
        'Sales copy and cross-page presentation': 'special-po-reference-browser.test.js: delivery and our-yard mobile popups, vendor pickup, page reload, real shared-header loader and Sales acknowledgement route',
        'existing Sales role filtering': 'special-sales-alert-browser.test.js: private Sales popup, public Sales/SCM/Dispatch exclusion'
    },
    'realDataReadOnlyPreviews': {
        'salesNotice': preview,
        'approvedDeliveryWindows': prior['realDataReadOnlyPreview']
    },
    'corrections': prior['corrections'] + [
        'New Sales audience, Queued gate and browser cases failed against the prior runtime before implementation.',
        'Time-change and cancellation RED reproduced missing actions/controls and retained cancelled SO associations. Additional cancellation-race and global-alert assertions also failed against the prior candidate.',
        'Legacy HTTP database guard now accepts only the standard disposable db host, mbt_test user and isolated database naming.',
        'Browser tests use installed Playwright headless Chromium instead of the full browser channel whose crashpad cannot start in the read-only test home; assertions unchanged.'
    ],
    'limitsAndSkippedLayers': prior['limitsAndSkippedLayers'] + [
        'Special PO TypeScript checks cover the shared pure helper. Server and browser modules also passed lint, syntax and real HTTP/browser tests.',
        'Queue eligibility uses existing local SCM status projection in batches of 200; no NetSuite requests or production acknowledgement writes.',
        'Five time-change domain mutants ran against unit and property suites separately; database-association and global-notification mutants ran against their integration/browser suites.',
        'Pending time changes have no expiry and leave the secured booking active until explicitly accepted, declined, withdrawn or cancelled. No existing confirmed scheduling records were rewritten.',
        'Six special PO manual mutants killed: two by the audience property alone, four by real HTTP owner/yard/queue/receipt tests.',
        'Separate request-loading test projects from another active task were observed on the shared host and not interrupted; this release owns no remaining test resources.',
        'Live app remains unchanged. An earlier automatic approval review rejected a follow-up deployment because the prior deploy instruction did not cover additional changes.'
    ],
    'supplyChainAndSecrets': {
        'dependenciesChanged': False, 'schemaChanged': False, 'diffSecretScanPassed': True,
        'newRuntimeCapabilities': 'No new external service, filesystem, subprocess or environment access.'
    },
    'testSourceHashes': {name: hashlib.sha256((server / name).read_bytes()).hexdigest() for name in test_paths},
    'finalCleanup': read(artifact / 'final-cleanup.json')
}
if (release / 'deployment-result.json').exists():
    deployed = read(release / 'deployment-result.json')
    assert deployed['deployed'] and deployed['candidateTreeHash'] == manifest['candidateTreeHash']
    report['status'] = 'deployed and verified after explicit user deployment approval'
    report['deployment'] = deployed
    report['liveFeatureChecks'] = read(release / 'live-feature-checks.json')
    report['editingLeases'] = read(release / 'editing-lease-result.json')
    report['limitsAndSkippedLayers'] = [line for line in report['limitsAndSkippedLayers']
                                       if not line.startswith('Live app remains unchanged.')]
    report['corrections'].append('The user explicitly approved the combined deployment; the live app now matches the validated image. Prior deployment approval block resolved.')
    if (release / 'live-feature-check-error.log').exists():
        report['corrections'].append('The first live SO check expected the earlier 08:00–09:00 example. Read-only inspection showed DR-000005 had been cancelled before deployment and both SOs were already secured on DR-000006 for 2026-10-09 10:00–12:00. The operational check now compares planning with the current approved record; deployed code and business data were not changed.')
    report['limitsAndSkippedLayers'].append('Pre-existing cancelled-request association rows remain historical and are excluded from active planning. New cancellations delete their associations atomically; no historical production records were rewritten during deployment.')
(artifact / 'EVIDENCE.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report['totals']))
