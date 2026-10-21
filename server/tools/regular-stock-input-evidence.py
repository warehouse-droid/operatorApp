"""Collect the saved final-run evidence without regenerating or inventing results."""
from pathlib import Path
import hashlib
import json
import re

server = Path(__file__).resolve().parents[1]
release = server / 'deployments/regular-stock-input-20261020'
folder = release / 'validation-artifacts/regular-stock-input-20261020'
load = lambda path: json.loads(path.read_text())
static = load(folder / 'static.json')
coverage = load(folder / 'changed-line-coverage.json')
manifest = load(release / 'manifest.json')
tests = []
for name in ['full.log', 'regressions.log']:
    log = (folder / name).read_text()
    counts = {key: int(re.findall(r'^# ' + key + r' (\d+)$', log, re.M)[-1]) for key in ['tests', 'pass', 'fail', 'skipped']}
    assert counts['fail'] == counts['skipped'] == 0 and counts['pass'] == counts['tests']
    tests.append({'log': str(folder / name), **counts})
assert all(static['hashes'][name] == manifest['candidateTree'][name] for name in manifest['files'])
assert (release / 'validation-cleanup-passed').exists()
deployment = load(release / 'deployment-result.json')
assert deployment['deployed']
rows = [json.loads(line) for line in (release / 'completed-request-readback.jsonl').read_text().splitlines()]
assert all(row['statusSummary']['status'] == 'completed' for row in rows if 'statusSummary' in row)
evidence = {
    'spec approval': 'not obtained (autonomous run)',
    'spec': str(server / 'test/regular-stock-input-spec.json'),
    'sourceTreeHash': manifest['candidateTreeHash'],
    'runtimeFiles': manifest['files'],
    'commands': {
        'workspace': 'bash server/tools/regular-stock-input-check.sh full',
        'releaseValidation': 'sudo -n bash server/tools/regular-stock-input-release-check.sh',
        'release': 'sudo -n python3 server/tools/regular-stock-input-release.py prepare|validated|build|apply|verify',
        'evidence': 'python3 server/tools/regular-stock-input-evidence.py'
    },
    'tests': tests,
    'acceptanceMapping': {
        'single multi-select Status and old preference migration': ['selected statuses', 'generated multi-status', 'legacy Case stage', 'API', 'browser'],
        'persistent scoped Sales action alerts including mixed work and >100 requests': ['Sales input', 'action alerts', '100', 'browser'],
        'expired Close audited, guarded and race safe': ['Close expired', 'closed expired', 'browser'],
        'purchase handoff and released lines count as completed': ['STREQ-000164', 'generated purchase handoffs'],
        'ordinary unconfirmed TO drafts stay active': ['unconfirmed legacy'],
        'authorized one-time legacy cleanup': str(server / 'artifacts/regular-stock-input-20261020/legacy-verified.jsonl')
    },
    'static': {
        'syntaxFiles': len(static['syntax']),
        'newLintDiagnostics': sum(len(row['added']) for row in static['lint']),
        'typeCheck': static['types'],
        'typeScope': ['public/regular-stock-status.js', 'src/regular-stock-domain.js'],
        'secretFindings': len(static['secrets']),
        'mutations': static['mutations'],
        'versions': static['versions']
    },
    'changedLineCoverage': {'executed': sum(row.get('covered', 0) for row in coverage),
                            'executable': sum(row.get('changedExecutable', 0) for row in coverage),
                            'files': coverage},
    'review': {
        'capabilityChanges': 'One authenticated audited local Close endpoint; Sales alerts read existing requester/yard-scoped evidence. No new external service or credentials.',
        'dependencies': 'No dependency, lockfile or schema changes; no new package audit needed.',
        'failuresResolved': ['Old single-select assertions adapted to the requested multi-select behavior.',
                             'Status dropdown aligned to avoid sidebar overlap; open menu retained through refresh.',
                             'SCM status controls disabled during saves to prevent ignored clicks.',
                             'Browser harness dismisses queued new action alerts; action timeouts bound stalled interactions.'],
        'limits': ['Targeted regular-stock suites, not the entire repository test suite.',
                   'Chromium desktop/mobile viewport coverage; other engines unverified.',
                   'No performance benchmark or full-repository format/type gate.',
                   'Properties use generated inputs; integration order remains serial for shared fixture isolation.',
                   'Uncovered changed lines, if any, are explicitly listed above; no 100% claim is implied.']
    },
    'deployment': deployment,
    'requests': rows,
    'cleanup': {'verified': True, 'containers': (folder / 'docker-all-full.log').read_text().splitlines(),
                'volumesRemoved': not (folder / 'volumes-full.log').read_text().strip(),
                'networksRemoved': not (folder / 'networks-full.log').read_text().strip(),
                'production': (folder / 'production-health-full.log').read_text().splitlines()},
    'sourceAndEvidenceHash': hashlib.sha256(json.dumps(static['hashes'], sort_keys=True).encode()).hexdigest()
}
target = server / 'artifacts/regular-stock-input-20261020/evidence.json'
target.write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps({'evidence': str(target), 'testsPassed': sum(row['pass'] for row in tests),
                  'changedLinesCovered': evidence['changedLineCoverage']['executed'],
                  'changedLinesExecutable': evidence['changedLineCoverage']['executable']}))
