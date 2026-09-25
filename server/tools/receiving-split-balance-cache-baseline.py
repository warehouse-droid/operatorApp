"""Replay the hard-coded old cache-version assertion on both saved baselines."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER / 'test-artifacts/receiving-split-balance'
LIVE = SERVER / 'test-artifacts/receiving-split-balance-deployment-20260922/baseline'
TEST = 'test/mbt/unit/operator-delivery-refresh.test.js'
FAILURE = 'P2 the installed operator shell precaches the versioned refresh guard and client together'
results = {}
for name in ['saved-workspace', 'captured-live']:
    args = ['sudo', '-n', 'docker', 'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:mode=1777',
            '-v', str(LIVE / 'public') + ':/app/public:ro', '-v', str(SERVER / 'test') + ':/app/test:ro']
    if name == 'saved-workspace':
        for file in ['operator.html', 'operator.js', 'service-worker.js']:
            args += ['-v', str(ROOT / 'before/public' / file) + ':/app/public/' + file + ':ro']
    args += ['-w', '/app', '--entrypoint', 'node', 'field-sales-check-2941306:latest', '--test', TEST]
    run = subprocess.run(args, capture_output=True, text=True)
    output = run.stdout + run.stderr
    (ROOT / ('cache-baseline-' + name + '.log')).write_text(output)
    failed = re.findall(r'^not ok \d+ - (.+)$', output, re.M)
    assert run.returncode == 1 and failed == [FAILURE], output
    results[name] = {'failures': failed, 'testSha256': hashlib.sha256((SERVER / TEST).read_bytes()).hexdigest(),
                     'htmlSha256': hashlib.sha256(((ROOT / 'before') if name == 'saved-workspace' else LIVE).joinpath('public/operator.html').read_bytes()).hexdigest()}

baseline = json.loads((SERVER / 'test/aggregate-access-existing-baseline.json').read_text())
baseline['failures'][TEST] = [FAILURE]
baseline['receivingSplitBaselineAddendum'] = {
    'reason': 'The previous Receiving deleted-line deployment advanced the Operator cache after the recorded full baseline. The unchanged test requires the obsolete Aggregate cache literal. Both saved pre-change workspace and captured live assets reproduce exactly this failure.',
    'reproductionTool': 'tools/receiving-split-balance-cache-baseline.py', 'replays': results
}
(SERVER / 'test/receiving-split-balance-existing-baseline.json').write_text(json.dumps(baseline, indent=2) + '\n')
print(json.dumps(results), flush=True)
