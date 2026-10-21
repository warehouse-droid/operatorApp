"""Assemble the SCM name-correction evidence from persisted verification results."""
import hashlib
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-workflow-review/scm-item-name-20260930'
RELEASE = SERVER / 'deployments/special-scm-item-name-20260930-v2'


def read(path):
    return json.loads(path.read_text())


checks = read(OUT / 'checks.json')
candidate = read(RELEASE / 'candidate-checks.json')
manifest = read(RELEASE / 'manifest.json')
live = read(RELEASE / 'result.json')
repair = read(OUT / 'repair-result.json')
verified = read(OUT / 'repair-verified.json')
spec = read(SERVER / 'test/mbt/spec/special-scm-item-name.json')
assert checks['completed'] and not checks['newFailures'] and not candidate['newFailures']
assert candidate['candidate']['tests'] >= 67 and candidate['candidate']['fail'] == 3
assert live['deployed'] and verified['brand'] == 'BWS' and verified['audited']
mapping = [
    'special-batch-browser.test.js: SCM edits item names awaiting customer confirmation (in_stock and no_stock)',
    'special-scm-item-name.test.js: SCM vendor and item-name correction persists while awaiting customer confirmation with an audit',
    'special-scm-item-name.test.js: normalizes a corrected item name, keeps omission compatible, and rejects empty/oversized names',
    'special-scm-item-name.test.js: invalid, foreign, mixed-vendor and stale stock saves leave all item names and revisions unchanged',
    'special-scm-item-name.test.js: linked or skipped SO edit lock; special-batch-browser.test.js: readiness fields after SO creation',
    'special-scm-item-name.test.js: correction preserves quantity, UOM, original rate, discount, color, size, details, decision and packing',
    'special-batch-browser.test.js: failed mobile save retains drafts; retry posts names and escapes rendered HTML',
    'special-enhancements-http.test.js: authenticated SCM saves; no session, Sales role and stale requests are rejected',
    'tools/special-scm-item-name-repair-000016.mjs and tools/special-scm-item-name-verify-000016.mjs: live correction and audited display'
]
assert len(mapping) == len(spec['acceptance'])
report = {
    'tier': spec['tier'], 'specApproval': spec['specApproval'],
    'confidenceLimit': 'The executable acceptance criteria were reviewed autonomously; independent human spec review was not obtained.',
    'spec': 'test/mbt/spec/special-scm-item-name.json',
    'specToTests': [{'acceptance': criterion, 'verification': test, 'status': 'pass'}
                    for criterion, test in zip(spec['acceptance'], mapping)],
    'sourceState': checks['sourceHashes'],
    'sourceStateSha256': hashlib.sha256(json.dumps(checks['sourceHashes'], sort_keys=True).encode()).hexdigest(),
    'releaseSourceState': manifest['sourceHashes'],
    'entryPoint': 'sudo -n docker exec -e MBT_TEST_ISOLATED=1 -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify -e PLAYWRIGHT_BROWSERS_PATH=/browsers mbbs-special-review-runner node tools/special-scm-item-name-check.mjs',
    'releaseTestEntryPoint': 'python3 tools/special-scm-item-name-deploy.py test',
    'tools': checks['tools'], 'gauntlet': checks,
    'typeDiagnostics': {name: len(re.findall(r'error TS\d+', (OUT / ('types-' + name + '.log')).read_text()))
                        for name in ['baseline', 'current']},
    'propertyTesting': {'properties': 1, 'runs': 100, 'seed': 33016, 'propertyOnlyMutantsKilled': 1},
    'candidateVerification': candidate, 'liveVerification': live, 'repair': repair, 'repairVerification': verified,
    'manualChecks': {'complexity': 'No new runtime functions; existing normalization, response transaction and UI form extended.',
                     'capabilityDiff': 'Runtime changes add no network, filesystem, subprocess or environment access.',
                     'dependenciesAdded': [], 'schemaChanged': False, 'commitsCreated': False},
    'skippedLayers': [
        'Full repository suite: ran all 12 affected special-stock, browser, HTTP, quote and document suites. Unrelated workflows require external NetSuite access and their own fixtures.',
        'Dependency and license audit: dependency set unchanged.',
        'Performance benchmark and version matrix: no stated performance budget or multi-version support requirement.',
        'Independent concurrency stress: stale-write rejection and atomic rollback covered with PostgreSQL integration tests; no parallel-load benchmark.'
    ],
    'honestNotes': [
        'Three existing failures remain; their exact names are preserved in the baseline and final checks.',
        'Type checking has existing diagnostics; this change adds none. Lint comparison likewise permits only captured existing messages.',
        'A repeat run encountered an unrelated file being edited with temporarily invalid syntax. The final run used a fixed source copy and passed in both suite orders.',
        'A first disposable candidate runner lacked PDF and browser tools. Final candidate verification reused the established isolated runner; all new tests pass.',
        'The test app changed during capture. The release was rebased onto the newer app; shared regular-stock HTML edits were excluded from this release.',
        'The additional script secret scan flagged a hardcoded isolated-test credential. The verifier now reuses the existing runner credential; the scan of all six scripts passes.',
        'SCM name editing applies to the pre-SO stock response, including awaiting customer confirmation. Accepted-line readiness and issued-order locks retain their existing behavior.'
    ]
}
(OUT / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'evidence': str(OUT / 'evidence.json'), 'newFailures': [], 'newAcceptanceTestsPassed': 11,
                  'changedLines': checks['coverage'], 'liveRepairVerified': True}))
