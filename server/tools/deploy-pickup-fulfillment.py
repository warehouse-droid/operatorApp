"""Release only verified pickup reconciliation files over the live app image."""
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pickup_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
CHECKS = SERVER / 'test-artifacts/pickup-existing-if/final'
core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/pickup-existing-if-20260922-v1')
core.BEFORE = SERVER / 'test-artifacts/pickup-existing-if/baseline'
core.IMAGE = 'mbbs-operator-app:pickup-existing-if-20260922-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-pickup-existing-if-20260922-v1'
core.EXISTING = ['src/operator-netsuite-posting-' + name + '.js' for name in ['targets', 'domain', 'finalizer', 'service']]
core.ADDED = ['src/operator-pickup-existing-if-domain.js', 'src/operator-pickup-existing-if-source.js']
core.FILES = sorted(core.EXISTING + core.ADDED)

original_docker = core.docker


def workspace_docker(*args, **kwargs):
    if args[0] != 'cp':
        return original_docker(*args, **kwargs)
    target = Path(args[2])
    assert target.resolve().is_relative_to(core.RELEASE.resolve())
    with tarfile.open(fileobj=io.BytesIO(original_docker('cp', args[1], '-', **kwargs))) as archive:
        assert all(Path(member.name).parts[0] == target.name for member in archive.getmembers())
        archive.extractall(target.parent, filter='data')
    return b''


core.docker = workspace_docker


def source_gate(full=False):
    source = json.loads((CHECKS / 'source.json').read_text())
    checks = json.loads((CHECKS / 'checks.json').read_text())
    assert checks['sourceHash'] == source['sourceHash']
    assert checks['newTypeErrors'] == checks['newLint'] == 0
    assert checks['changedLineCoverage']['missing'] == []
    assert len(checks['mutations']['unit']) == len(checks['mutations']['property']) == 7
    for name, digest in source['files'].items():
        assert core.digest((SERVER / name).read_bytes()) == digest, 'Verified source changed: ' + name
    if full:
        regression = json.loads((CHECKS / 'regression.json').read_text())
        assert regression['sourceHash'] == source['sourceHash'] and not regression['newFullSuiteFailures']
    return source


def prepare():
    source_gate()
    core.prepare()


def build():
    source_gate()
    core.build()


def check():
    source_gate()
    state = core.manifest()
    core.current(state)
    candidate = core.RELEASE / 'candidate'
    for folder in ['test', 'tools', 'contracts']:
        shutil.copytree(SERVER / folder, candidate / folder, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
    for pattern in ['*.json', '*.js', 'Dockerfile*']:
        for file in SERVER.glob(pattern):
            shutil.copy2(file, candidate / file.name)
    files = ['test/mbt/unit/pickup-existing-if.test.js', 'test/mbt/property/pickup-existing-if.property.test.js',
             'test/mbt/adversarial/pickup-existing-if.test.js', 'test/mbt/integration/pickup-existing-if.test.js',
             'test/mbt/integration/pickup-existing-if-http.test.js']
    files += ['test/mbt/unit/operator-netsuite-posting-' + name + '.red.test.js'
              for name in ['domain', 'targets', 'service', 'admission', 'runtime']]
    with (core.RELEASE / 'candidate-tests.log').open('w') as output:
        subprocess.run(['sudo', '-n', 'env', 'PICKUP_IF_SOURCE_ROOT=' + str(candidate), 'bash',
                        str(SERVER / 'tools/pickup-existing-if-test.sh'), 'node', '--test', '--test-concurrency=1', *files],
                       cwd=SERVER, stdout=output, stderr=subprocess.STDOUT, check=True)
    assert '# pass 102\n# fail 0' in (core.RELEASE / 'candidate-tests.log').read_text()
    # Import the actual built runtime without starting queues or attaching live data.
    core.docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '--entrypoint', 'node',
                state['candidateImageId'], '--input-type=module', '-e',
                "await import('./src/operator-netsuite-posting-controller.js'); await import('./src/operator-netsuite-posting-runtime.js'); console.log('runtime imports passed')")
    core.save('verified.json', {'imageId': state['candidateImageId'], 'passed': True, 'tests': 102})
    print(json.dumps({'candidateTestsPassed': 102, 'image': core.IMAGE}), flush=True)


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    after = core.metadata(core.APP)
    assert after['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    rows = core.docker('exec', core.APP, 'sha256sum', *['/app/' + file for file in core.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == state['after']
    probe = """import assert from 'node:assert/strict';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 const policy=await fetch(base+'/api/operator/netsuite-posting-policy');assert.equal(policy.status,401);
}
console.log(JSON.stringify({localHealth:200,publicHealth:200,anonymousPolicy:401}));"""
    http = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=probe.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': core.IMAGE,
              'imageId': state['candidateImageId'], 'runtimeFiles': core.FILES, 'configurationPreserved': True,
              'workerAndDependenciesUnchanged': True, 'databaseChanges': False, **http}
    core.save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    source_gate(full=True)
    state = core.manifest()
    core.current(state)
    checked = json.loads((core.RELEASE / 'verified.json').read_text())
    assert checked['passed'] and checked['imageId'] == state['candidateImageId']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', core.IMAGE).decode().strip() == state['candidateImageId']
    configured = json.loads(subprocess.check_output(core.compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=core.ROOT))['services']['app']
    image_config = json.loads(core.docker('image', 'inspect', state['candidateImageId']))[0]['Config']
    current_config = json.loads(core.docker('inspect', core.APP))[0]['Config']
    expected = dict(value.split('=', 1) for value in image_config['Env'])
    expected.update({key: str(value) for key, value in configured.get('environment', {}).items()})
    assert expected == dict(value.split('=', 1) for value in current_config['Env']), 'Environment drift'
    for field, service_key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        value = configured.get(service_key)
        assert (image_config.get(field) if value is None else value) == current_config.get(field), field
    assert core.database("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing');").strip() == '0', 'Wait for active postings'
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (core.RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.release.yml') + command, cwd=core.ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (core.RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.rollback.yml') + command, cwd=core.ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': build, 'check': check, 'apply': apply, 'verify': verify}[sys.argv[1]]()
