"""Run the incident replay against old and candidate images, without source overlays."""
import importlib.util
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', ROOT / 'tools/operator-suiteql-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
state = core.manifest()
ART = ROOT / 'test-artifacts/operator-suiteql'
network = 'mbbs-operator-suiteql-image-' + uuid.uuid4().hex[:10]
database = network + '-db'
env = {'MBT_TEST_ISOLATED': '1', 'MBT_ENABLED': 'true', 'MBBS_ENV_FILE': '/nonexistent', 'NODE_ENV': 'test',
       'NETSUITE_DIRECT_ACCESS_ENABLED': 'false', 'SAMSARA_WRITES_ENABLED': 'false',
       'MBT_NETSUITE_WRITES_ENABLED': 'false', 'SMART_SCM_LIVE_EXECUTION_ENABLED': 'false',
       'DISPATCH_PLANNER_ORDER_POOL_MODE': 'off',
       'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test'}


def run(image, args, label):
    command = ['sudo', '-n', 'docker', 'run', '--rm', '--network', network, '--entrypoint', 'node']
    for key, value in env.items():
        command += ['-e', key + '=' + value]
    for file in ['tools/operator-suiteql-image-smoke.mjs', 'test/support/operator-suiteql-fixture.mjs']:
        command += ['-v', str(ROOT / file) + ':/app/' + file + ':ro']
    result = subprocess.run(command + [image, *args], capture_output=True, text=True, timeout=90)
    (ART / (label + '.log')).write_text(result.stdout + result.stderr)
    return result


try:
    core.docker('network', 'create', '--internal', network)
    core.docker('run', '-d', '--name', database, '--network', network, '--network-alias', 'db',
                '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_USER=mbt_test',
                '-e', 'POSTGRES_PASSWORD=mbt_test_password', '-e', 'POSTGRES_DB=mbt_test', 'postgres:18-alpine')
    for _ in range(30):
        if subprocess.run(['sudo', '-n', 'docker', 'exec', database, 'pg_isready', '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True).returncode == 0:
            break
        time.sleep(1)
    assert run(state['candidateImageId'], ['src/migrate.js'], 'image-migrate').returncode == 0
    before = run(state['app']['imageId'], ['tools/operator-suiteql-image-smoke.mjs'], 'image-before')
    assert before.returncode != 0 and 'Pickup validation is stuck behind unrelated SuiteQL' in before.stderr
    after = run(state['candidateImageId'], ['tools/operator-suiteql-image-smoke.mjs'], 'image-after')
    assert after.returncode == 0, 'Candidate image replay failed; see image-after.log'
    result = {**json.loads(after.stdout.strip().splitlines()[-1]), 'baselineBlocked': True,
              'candidateImageId': state['candidateImageId'], 'sourceHash': state['after']['src/netsuite.js']}
    (ART / 'image-smoke.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
finally:
    subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', database], capture_output=True)
    subprocess.run(['sudo', '-n', 'docker', 'network', 'rm', network], capture_output=True)
