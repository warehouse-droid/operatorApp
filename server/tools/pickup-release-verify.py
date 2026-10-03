"""Replay the pickup gauntlet from the captured source checkout; no live writes."""
import json
from pathlib import Path
import shutil
import subprocess

server = Path(__file__).resolve().parents[1]
release = server / 'deployments/dispatch-pickup-address-20261003'
artifacts = server / 'test-artifacts/dispatch-pickup-release-20261003'
manifest = json.loads((release / 'manifest.json').read_text())
baseline = release / 'before-app'
candidate = release / 'candidate-app'
files = json.loads((server / 'tools/pickup-release-files.json').read_text())
if not baseline.exists():
    baseline.mkdir()
    for name in files:
        target = baseline / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(server / name, target)
    subprocess.run(['patch', '--batch', '--fuzz=0', '-R', '-p1', '-d', str(baseline)],
                   input=(release / 'workspace.patch').read_bytes(), check=True)
if not candidate.exists():
    candidate.mkdir()
    for name in ['src', 'public', 'migrations']:
        shutil.copytree(server / name, candidate / name)
    for name in ['package.json', 'package-lock.json']:
        shutil.copy2(server / name, candidate / name)
import hashlib
for name in files:
    for folder, expected in [(baseline, manifest['services']['app']['beforeTree']),
                             (server, manifest['services']['app']['tree'])]:
        assert hashlib.sha256((folder / name).read_bytes()).hexdigest() == expected[name], name
artifacts.mkdir(parents=True, exist_ok=True)
(artifacts / 'runtime').mkdir(exist_ok=True)
# The helper refuses existing container names; only clean up after our own start.
subprocess.run(['bash', 'tools/boss-test-env.sh', 'start'], cwd=server, check=True)
try:
    subprocess.run(['docker', 'exec', 'mbbs-boss-test-runner', 'node', 'src/migrate.js'], check=True)
    args = ['docker', 'run', '--rm', '--network', 'mbbs-boss-test', '--read-only',
            '--tmpfs', '/tmp:mode=1777', '--tmpfs', '/app/data:mode=1777',
            '-v', str(artifacts / 'runtime') + ':/app/test-artifacts', '-v', str(server) + ':/workspace:ro']
    for name in ['src', 'public', 'migrations', 'package.json', 'test', 'tools', 'contracts', 'eslint.mbt.config.js', 'tsconfig.mbt.json']:
        args += ['-v', str(server / name) + ':/app/' + name + ':ro']
    for value in ['NODE_ENV=test', 'MBT_TEST_ISOLATED=1', 'MBBS_ENV_FILE=/nonexistent',
                  'DATABASE_URL=postgres://mbt_test:boss_test_only@db:5432/mbt_test',
                  'NETSUITE_DIRECT_ACCESS_ENABLED=false', 'NETSUITE_MIRROR_ROLE=disabled',
                  'SAMSARA_WRITES_ENABLED=false', 'MBT_NETSUITE_WRITES_ENABLED=false',
                  'SMART_SCM_LIVE_EXECUTION_ENABLED=false', 'SALES_PUBLIC_ACCESS_ENABLED=false',
                  'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright']:
        args += ['-e', value]
    subprocess.run(args + ['mbbs-regular-v2:e2e', 'node', 'tools/pickup-release-gauntlet.mjs'], check=True)
    shutil.copy2(artifacts / 'runtime/pickup-release/gauntlet-results.json', artifacts / 'gauntlet-results.json')
    subprocess.run(['python3', 'tools/pickup-release-evidence.py'], cwd=server, check=True)
finally:
    subprocess.run(['bash', 'tools/boss-test-env.sh', 'stop'], cwd=server, check=True)
