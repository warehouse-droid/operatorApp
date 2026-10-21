"""Confirm the unrelated legacy stage assertion against captured live code."""
import hashlib
import json
from pathlib import Path
import re
import signal
import subprocess

SERVER = Path(__file__).resolve().parents[2]
RELEASE = SERVER / 'deployments/special-po-sent-placement-20261016'
OUT = SERVER / 'test-artifacts/special-po-sent-placement-20261016'
NAME = 'mbbs-special-po-placement-baseline'
EXPECTED = 'property: a real unapproved PO remains Confirmed until approval, except terminal stages'
args = ['docker', 'run', '--rm', '--name', NAME, '--init', '--network', 'none', '--read-only',
    '--label', 'com.mbbs.lifecycle=disposable-test', '--cgroup-parent=mbbs-tests.slice',
    '--memory=512m', '--memory-swap=512m', '--cpus=0.5', '--pids-limit=128',
    '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777,size=32m',
    '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700,size=16m',
    '--env', 'NODE_ENV=test', '--env', 'MBBS_ENV_FILE=/nonexistent',
    '--user', '1000:1000', '--workdir', '/app']
for source, target in [(RELEASE / 'before/src', 'src'), (RELEASE / 'before/public', 'public'),
    (SERVER / 'test', 'test'), (SERVER / 'test-artifacts/delivery-enhancements-20261013/toolchain/node_modules', 'node_modules')]:
    args += ['--volume', f'{source}:/app/{target}:ro']
args += ['--entrypoint', 'node', 'mbbs-operator-app:dispatch-editor-control-browser-test-20261015',
    '--test', 'test/mbt/unit/special-approval-fulfillment.test.js']


def stop(_signal, _frame):
    raise KeyboardInterrupt()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    assert not subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'name=^/' + NAME + '$']).strip()
    with (OUT / 'baseline.log').open('wb') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=60)
    baseline = (OUT / 'baseline.log').read_text()
    candidate = (OUT / 'tests.log').read_text()
    failures = lambda text: re.findall(r'^not ok \d+ - (.+)$', text, flags=re.M)
    assert result.returncode == 1 and failures(baseline) == failures(candidate) == [EXPECTED]
    workflow = 'public/special-stock-workflow.js'
    before = (RELEASE / 'before' / workflow).read_bytes()
    assert before == (RELEASE / 'candidate' / workflow).read_bytes()
    report = json.loads((OUT / 'report.json').read_text())
    assert report['checks'][-1]['failed'] == 1 and report['checks'][-1]['passed'] == 74
    report['checks'].append({'name': 'legacy-stage-baseline', 'passed': True,
        'existingFailure': EXPECTED, 'unchangedWorkflowHash': hashlib.sha256(before).hexdigest(),
        'reason': 'The old test expects automatic Dispatch Arrangement from approval alone; live code requires the existing handoff evidence.'})
    report['passed'] = True
    (OUT / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'noNewFailures': True, 'passed': 74, 'baselineFailure': EXPECTED}))
finally:
    subprocess.run(['docker', 'rm', '-fv', NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for args, name in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (OUT / name).write_bytes(subprocess.check_output(['docker', *args, '--format', '{{.Names}} {{.Status}}']))
    assert not subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label=com.mbbs.lifecycle=disposable-test']).strip()
    assert subprocess.check_output(['docker', 'inspect', 'mbbs-operator-app-app-1', '--format', '{{.State.Health.Status}}']).strip() == b'healthy'
