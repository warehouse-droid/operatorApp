"""Evidence for the additional backend/editor/observer check; retain prior runs."""
import hashlib
import json
from pathlib import Path

server = Path(__file__).resolve().parents[1]
root = server / 'test-artifacts/dispatch-freshness-20261019'
results = root / 'results'
day = json.loads((results / 'full-day-replay/latest.json').read_text())
checks = day['consistencyChecks']
negative = json.loads((results / 'backend-frontend-negative-control/result.json').read_text())
correction = json.loads((root / 'backend-frontend-harness-correction.json').read_text())
assert Path(day['artifact']).name != Path(correction['invalidatedReplay']).name
assert day['status'] == 'passed' and len(checks) >= 40
assert all(row['status'] == 'passed' for row in checks)
assert negative['killed']
assert not day['refreshAudit']['manualRefreshClicks']
assert [row['action'] for row in day['refreshAudit']['navigations']] == [
    'Load dispatch page (editor)', 'Load dispatch page (observer)',
    'Reload saved editing session', 'Reopen confirmed day'
]
hashes = {row['file']: row['sha256'] for row in json.loads((results / 'changed-line-coverage.json').read_text())}
assert day['runtimeHashes'] == hashes
assert all(hashlib.sha256((server / file).read_bytes()).hexdigest() == value for file, value in hashes.items())
assert 'teardown_exit=0' in (root / 'teardown.log').read_text()
production = {'mbbs-operator-app-app-1', 'mbbs-operator-app-db-1',
              'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1'}
for file in ['docker-ps.log', 'docker-ps-a.log']:
    lines = (root / file).read_text().splitlines()
    assert {line.split()[0] for line in lines} == production
    assert any(line.startswith('mbbs-operator-app-app-1 ') and '(healthy)' in line for line in lines)

evidence = {
    'status': 'passed', 'specBehavior': 22, 'specApproval': 'not obtained (autonomous run)',
    'runtimeChangedInThisFollowup': True, 'runtimeHashes': hashes,
    'fixes': ['Rental decoration no longer treats an ordinary group based at 3445 as a rental group, and retains linked PO/TO pickup locations for actual rentals.',
              'Starting a drag cancels the pending selection repaint so it cannot detach the native drag source.'],
    'testSha256': hashlib.sha256((server / 'test/dispatch/frontend/dispatch-full-day.browser.test.mjs').read_bytes()).hexdigest(),
    'checksPassed': len(checks), 'manualRefreshClicks': 0,
    'covered': ['PO link/unlink including group children', 'TO link/mode/unlink', 'split/further split/unsplit',
                'group/ungroup and retired identities', 'CO create/cancel and source pickup',
                'drag autosave', 'all manual saves', 'confirmation and identical load stops'],
    'timingDefinition': day['consistencyTimingDefinition'],
    'timingRangesMs': {key: [min(row[key] for row in checks), max(row[key] for row in checks)]
                       for key in ['backendAcknowledgedMs', 'backendVerifiedMs', 'editorConsistentByMs', 'observerConsistentByMs']},
    'slowVerificationChecks': [row['number'] for row in checks if row['slow']],
    'refreshAudit': day['refreshAudit'], 'negativeControl': negative,
    'verificationCorrection': correction,
    'replayArtifact': day['artifact'],
    'commands': ['bash server/tools/dispatch-full-day-replay.sh',
                 'bash server/tools/dispatch-freshness-test.sh node tools/dispatch-consistency-mutant.mjs',
                 'python3 server/tools/dispatch-full-day-report.py',
                 'python3 server/tools/dispatch-consistency-evidence.py'],
    'cleanup': 'Both bounded Compose runs removed their disposable containers, database storage and network; docker ps/ps -a contain only production; production health check passed.',
    'limitations': [
        'These measurements use isolated synthetic data, not production orders or live external integrations.',
        'Backend acknowledgment bounds commit time; database commit itself is not separately instrumented.',
        'Browser consistency times include fresh backend reads and verification overhead and are upper bounds, not first-render timestamps.',
        'Waiting for autosave consistency changes replay pacing; earlier uninterrupted action timings remain valid evidence of slow actions.',
        'Two later intentional reloads verify persistence. They are never used to repair state during a consistency check.',
        'The group pickup-summary fix was reproduced before editing application code; the complete freshness gauntlet was rerun after the fix.',
        'The application changes remain local and have not been deployed by this task.'
    ]
}
path = root / 'backend-frontend-evidence.json'
path.write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps({'status': evidence['status'], 'checksPassed': len(checks),
                  'negativeControlKilled': negative['killed'], 'evidence': str(path)}))
