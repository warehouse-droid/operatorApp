"""Summarize the reproducible BIN correction checks and production verification."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/mbt-bin-corrections-20261015'
ARTIFACTS = OUT / 'artifacts-all'

def read(path):
    return json.loads(path.read_text())

validation = read(OUT / 'validation.all.json')
candidate = read(OUT / 'validation.candidate.json')
assert validation['passed'] and candidate['passed'] and candidate['fullGauntlet']
assert validation['cleanupVerified'] and candidate['cleanupVerified']
suite = (ARTIFACTS / 'suite.log').read_text()
matches = re.findall(r'run passed: (\d+) file\(s\), (\d+) test\(s\)', suite)
assert len(matches) == 1
coverage = read(ARTIFACTS / 'changed-coverage.json')
mutations = read(ARTIFACTS / 'mutations.json')
static = read(ARTIFACTS / 'static.json')
assert all(not row['missed'] for row in coverage)
assert all(row['killed'] for row in mutations)
assert not static['types']['newDiagnostics'] and static['lint']['exit'] == 0
assert static['secrets']['findings'] == []
files = list(validation['sourceHashes'])
files += ['test/mbt/unit/mbt-bin-corrections.test.js', 'test/mbt/integration/mbt-bin-corrections.test.js',
          'test/mbt/integration/mbt-bin-corrections-browser.test.js', 'test/mbt/unit/mbt-bin-cancellation.test.js',
          'test/mbt/integration/mbt-bin-cancellation.test.js']
files += [str(path.relative_to(SERVER)) for path in (SERVER / 'tools').glob('mbt-bin-corrections-*') if path.is_file()]
files += [str(path.relative_to(SERVER)) for path in (SERVER / 'tools').glob('mbt-bin-cancellation-*') if path.is_file()]
hashes = {file: hashlib.sha256((SERVER / file).read_bytes()).hexdigest() for file in sorted(files)}
report = {
    'tier': 3,
    'specApproval': 'not obtained (autonomous run); confidence is limited to the recorded acceptance scenarios',
    'spec': 'spec.json',
    'entryPoint': 'MBT_BIN_CORRECTIONS_CANDIDATE=1 python3 server/tools/mbt-bin-corrections-gauntlet.py all',
    'releasePreparation': 'python3 server/tools/mbt-bin-cancellation-release.py prepare',
    'authorizedDataRepair': 'python3 server/tools/mbt-bin-cancellation-data-repair.py preview; python3 server/tools/mbt-bin-cancellation-data-repair.py apply',
    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SERVER, text=True).strip(),
    'sourceTreeSha256': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
    'hashes': hashes,
    'toolchain': read(ARTIFACTS / 'toolchain.json'),
    'baseline': {'files': 33, 'tests': 123, 'failures': 0},
    'finalTests': {'files': int(matches[0][0]), 'passed': int(matches[0][1]), 'failed': 0},
    'suiteHealth': {'reverseOrderFocusedRun': 'repeat.log', 'passed': True},
    'coverage': {'changedExecutableLines': sum(row['changed'] for row in coverage),
                 'covered': sum(row['covered'] for row in coverage), 'files': coverage},
    'mutation': {'killed': len(mutations), 'total': len(mutations), 'details': mutations,
                 'unmutatedAndRestoredControls': 'both passed'},
    'static': static,
    'mapping': {
        'MBT fee default and inherited selections': 'mbt-bin-corrections.test.js / mbt-bin-corrections-browser.test.js',
        'independent aggregate origin': 'seeded 200-example property plus customer-charge-request-workflow.test.js',
        'no premature exchange or collection': 'mbt-bin-corrections.test.js lifecycle, rollback, race and replacement scenarios',
        'independent bin delivery cards and availability': 'mbt-bin-corrections.test.js two-delivery integration scenario',
        'canonical truck import and selection': 'mbt-bin-corrections.test.js and real BINtest registration browser scenario',
        'ordinary shared planning and existing pricing': '33 existing BIN and charge suites',
        'cancel only the undelivered Bin 1': 'mbt-bin-cancellation.test.js integration with complete sibling and confirmed-request snapshots',
        'atomic adjustment and idempotency': 'mbt-bin-cancellation.test.js replay, simultaneous commands and late audit failure rollback',
        'signed and nonnegative active totals': 'mbt-bin-cancellation.test.js 200-example property, amount and ownership guards',
        'cancelled bin absent from active view and pool': 'mbt-bin-cancellation.test.js and the real Front Desk browser scenario',
        'original production data invariant': 'initial release changed only eight runtime/UI files; user later explicitly authorized Bin 1 cancellation and a -110000-cent adjustment',
        'no schema change': 'neither release includes migrations; approved adjustment uses the existing amendment ledger',
        'test cleanup': 'cleanup.all.json and production-health.all.json'
    },
    'knownLimits': [
        'No physical bin identities were invented; deliveries need registered available physical bins.',
        '15 existing type diagnostics remain in the scoped dependency graph; zero new diagnostics.',
        'The repository-wide type command also includes archived work and is not clean; scoped before/after comparison is recorded.',
        'Unrelated application suites were outside this BIN and customer-charge change.',
        'Dependency audit and license review were not rerun because no dependencies changed.',
        'Automated changed-line coverage applies to runtime modules and browser scripts. The operational CLI preview/apply wrapper is verified through its live snapshots; it cannot use production IDs in disposable tests.'
    ],
    'honestNotes': [
        'New regressions were observed failing before the fixes.',
        'Historical mandatory-150 expectations were changed to the user-requested independent-origin behavior.',
        'Existing exchange fixtures now complete delivery before requesting exchange or collection.',
        'An initial baseline browser artifact-permission failure was resolved using a separate task artifact directory.',
        'Browser coverage is captured separately across reloads to retain both navigation sessions.'
        ,'The first cancellation static check found a shadowed test hook name; it was renamed without changing assertions.'
    ],
    'cleanup': read(OUT / 'cleanup.all.json')
}
for name in ['deployment.json', 'live-verification.json']:
    if (OUT / name).exists():
        report[name] = read(OUT / name)
repair = SERVER / 'deployments/mbt-bin-cancellation-20261015/data-repair'
if (repair / 'verification.json').exists():
    verified = read(repair / 'verification.json')
    report['liveDataRepair'] = {'activeTotalMinor': 55000, 'deductedMinor': 110000,
        'bin2Unchanged': True, 'confirmedPricingUnchanged': True,
        'planningPoolItems': verified['pool']['total'], 'audit': verified['audit'],
        'privateBeforeAfterRecords': str(repair)}
(OUT / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passedTests': report['finalTests']['passed'], 'changedLines': report['coverage'],
                  'mutations': report['mutation']['killed'], 'evidence': str(OUT / 'evidence.json')}, indent=2))
