"""Offline, disposable and bounded status regression runner."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-artifacts/special-status-following-20261005'
OUT.mkdir(exist_ok=True)
IMAGE = 'sha256:087db416dc024ccf13e0b7ea732853e2e93ce3561937f1e301a540a9aab098c7'
mode = sys.argv[1] if len(sys.argv) > 1 else 'final'
args = ['docker', 'run', '--rm', '--network', 'none', '--init',
        '--cgroup-parent=mbbs-tests.slice', '--memory=2g', '--memory-swap=2g',
        '--cpus=1', '--pids-limit=512', '--tmpfs', '/tmp:rw,size=512m',
        '--name', 'mbbs-special-status-following-test',
        '--label', 'com.mbbs.lifecycle=disposable-test', '--workdir', '/app',
        '--env', 'NODE_ENV=test', '--env', 'MBT_TEST_ISOLATED=1',
        '--env', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '--env', 'MBBS_ENV_FILE=.env.special-status-tests']
for directory in ['src', 'public', 'test', 'tools', 'migrations']:
    args += ['--mount', f'type=bind,src={ROOT / directory},dst=/app/{directory},readonly']
for filename in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']:
    args += ['--mount', f'type=bind,src={ROOT / filename},dst=/app/{filename},readonly']
args += ['--mount', f'type=bind,src={OUT},dst=/app/test-artifacts/special-status-following-20261005', IMAGE]
args[-1:-1] = ['--mount', f'type=bind,src={ROOT / "tools/special-status-following-20261005/test.env"},dst=/app/.env.special-status-tests,readonly']
if mode == 'red':
    args += ['node', '--test', 'test/mbt/unit/special-status-following.test.js']
elif mode == 'focused':
    args += ['node', '--test', 'test/mbt/unit/special-status-following.test.js', 'test/mbt/unit/special-logistics-progress.test.js']
elif mode == 'physical-red':
    args += ['node', '--test', 'test/mbt/unit/special-logistics-progress.test.js']
elif mode == 'coverage':
    args += ['node', 'tools/special-status-following-20261005/browser-coverage.mjs']
elif mode == 'final':
    args += ['node', 'tools/special-status-following-20261005/gauntlet.mjs']
else:
    raise ValueError('Expected red, focused, physical-red, coverage or final')
try:
    result = subprocess.run(args, capture_output=True, text=True)
    log = result.stdout + result.stderr
    (OUT / (mode + '-runner.log')).write_text(log)
    print(json.dumps({'mode': mode, 'exitCode': result.returncode, 'output': log[-6500:]}))
finally:
    subprocess.run(['docker', 'rm', '-f', '-v', 'mbbs-special-status-following-test'], capture_output=True)
if result.returncode == 0 and mode == 'final':
    subprocess.run(['python3', str(ROOT / 'tools/special-status-following-20261005/run_db.py')], check=True)
    subprocess.run(['python3', str(ROOT / 'tools/special-status-following-20261005/coverage.py')], check=True)
    subprocess.run(['python3', '-m', 'py_compile', *[str(ROOT / 'tools/special-status-following-20261005' / name)
        for name in ['run.py', 'run_db.py', 'coverage.py', 'deploy.py', 'cleanup.py', 'evidence.py']]], check=True)
    subprocess.run(['python3', str(ROOT / 'tools/special-status-following-20261005/cleanup.py')], check=True)
raise SystemExit(result.returncode)
