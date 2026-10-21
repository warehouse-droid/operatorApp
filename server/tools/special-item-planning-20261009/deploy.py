"""Release only the tested Special Item planning restriction removal, with rollback."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/special-item-planning-20261009'
EVIDENCE = SERVER / 'test-artifacts/special-item-planning-20261009'
FILE = 'src/dispatch-plan-repository.js'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1', 'mbbs-operator-app-webhook-worker-1']
IMAGE = 'mbbs-operator-app:special-item-planning-20261009'
spec = importlib.util.spec_from_file_location('special_planning_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata = core.docker, core.metadata

def digest(value):
    return hashlib.sha256(value).hexdigest()

def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')

def state():
    return json.loads((RELEASE / 'manifest.json').read_text())

def evidence():
    result = json.loads((EVIDENCE / 'summary.json').read_text())
    for file, expected in result['hashes'].items():
        assert digest((SERVER / file).read_bytes()) == expected, 'Changed after verification: ' + file
    assert not json.loads((EVIDENCE / 'static.json').read_text())['newTypeErrors']
    assert not json.loads((EVIDENCE / 'changed-coverage.json').read_text())['missing']
    mutants = json.loads((EVIDENCE / 'mutations.json').read_text())
    assert len(mutants) == 3 and all(row['killed'] for row in mutants)
    cleanup = json.loads((EVIDENCE / 'cleanup-final.json').read_text())
    assert cleanup['teardownExit'] == 0 and cleanup['productionHealthy'] and not cleanup['testContainers']
    return result

def current(data):
    assert metadata(APP) == data['app'], 'Live application changed; recapture before release'
    assert [metadata(name) for name in DEPENDENCIES] == data['dependencies'], 'Another service changed'
    assert digest((SERVER / FILE).read_bytes()) == data['after'], 'Workspace changed after capture'
    assert digest(docker('exec', APP, 'cat', '/app/' + FILE)) == data['before'], 'Live source changed'

def compose(data, filename):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in data['app']['configFiles'].split(','):
        args += ['-f', file]
    return args + ['-f', str(RELEASE / filename)]

def prepare():
    verified = evidence()
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    before = docker('exec', APP, 'cat', '/app/' + FILE)
    baseline = (SERVER / 'tools/special-item-planning-20261009/baseline' / FILE).read_bytes()
    assert before == baseline, 'The live source changed since regression capture'
    after = (SERVER / FILE).read_bytes()
    data = {'app': metadata(APP), 'dependencies': [metadata(name) for name in DEPENDENCIES],
            'before': digest(before), 'after': digest(after), 'sourceHash': verified['sourceHash'],
            'files': [FILE], 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    data['baseImageTag'] = 'mbbs-operator-app:special-item-planning-base-' + data['app']['imageId'].split(':')[-1][:12]
    previous = RELEASE / 'before' / FILE
    previous.parent.mkdir(parents=True, exist_ok=True)
    previous.write_bytes(before)
    candidate = RELEASE / 'candidate' / FILE
    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_bytes(after)
    (RELEASE / 'candidate/Dockerfile').write_text('FROM ' + data['baseImageTag'] + '\nCOPY --chown=node:node ' + FILE + ' /app/' + FILE + '\n')
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + data['app']['imageId'] + '\n')
    save('manifest.json', data)
    current(data)
    docker('tag', data['app']['imageId'], data['baseImageTag'])
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '--network=none', '-t', IMAGE, str(RELEASE / 'candidate')],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    data['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    docker('tag', data['app']['imageId'], 'mbbs-operator-app:rollback-special-item-planning-20261009')
    save('manifest.json', data)
    current(data)
    before_config = json.loads(subprocess.check_output(compose(data, 'compose.rollback.yml') + ['config', '--format', 'json'], cwd=ROOT))
    after_config = json.loads(subprocess.check_output(compose(data, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    before_config['services']['app'].pop('image', None)
    assert after_config['services']['app'].pop('image') == IMAGE
    assert before_config == after_config, 'Compose configuration would change'
    # A one-off syntax check uses the same aggregate test budget and removes itself.
    try:
        docker('run', '--rm', '--init', '--network=none', '--read-only', '--cgroup-parent=mbbs-tests.slice',
               '--memory=256m', '--memory-swap=256m', '--cpus=1', '--pids-limit=64',
               '--tmpfs', '/tmp:size=64m', '--label', 'com.mbbs.lifecycle=disposable-test',
               '--name', 'mbbs-special-item-planning-candidate-check', '--entrypoint', 'node', IMAGE, '--check', FILE)
    finally:
        remaining = docker('ps', '-a', '--filter', 'name=^/mbbs-special-item-planning-candidate-check$', '--format', '{{.ID}}').decode().strip()
        if remaining:
            docker('rm', '-f', '-v', remaining)
    save('prepared.json', {'candidateImageId': data['candidateImageId'], 'files': [FILE], 'configurationPreserved': True})
    print(json.dumps({'prepared': True, 'files': [FILE], 'imageId': data['candidateImageId']}), flush=True)

def verify():
    data = state()
    core.ready(data['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == data['candidateImageId']
    assert actual['configuration'] == data['app']['configuration'], 'Configuration drift'
    assert [metadata(name) for name in DEPENDENCIES] == data['dependencies'], 'Other production services changed'
    assert digest(docker('exec', APP, 'cat', '/app/' + FILE)) == data['after']
    live = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module',
        input=(SERVER / 'tools/special-item-planning-20261009/live.mjs').read_bytes()))
    active = docker('ps', '--format', '{{.Names}} {{.Status}}').decode()
    all_containers = docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode()
    tests = docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}').decode().strip()
    assert not tests, tests
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': actual['imageId'], 'runtimeHash': data['after'], 'onlyAppChanged': True,
              'configurationPreserved': True, 'migration': None, 'dockerPs': active, 'dockerPsA': all_containers, **live}
    save('deployment-result.json', result)
    (EVIDENCE / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ['dockerPs', 'dockerPsA']}), flush=True)

def apply():
    data = state()
    evidence()
    current(data)
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    resolved = json.loads(subprocess.check_output(compose(data, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    image_config = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    runtime_config = json.loads(docker('inspect', APP))[0]['Config']
    expected_env = dict(entry.split('=', 1) for entry in image_config['Env'])
    expected_env.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert expected_env == dict(entry.split('=', 1) for entry in runtime_config['Env']), 'Environment would change'
    for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        assert (resolved.get(option) if resolved.get(option) is not None else image_config.get(field)) == runtime_config.get(field), field
    active = docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=b"import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(\"SELECT count(*)::int AS count FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')\")).rows[0]));}finally{await closeDb();}")
    assert json.loads(active)['count'] == 0, 'Wait for operator posting to finish'
    current(data)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(compose(data, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(data['app']['imageId'])
        save('rollback-result.json', {'previousAppRestored': True})
        raise

if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
