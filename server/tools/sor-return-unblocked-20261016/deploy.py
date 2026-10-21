"""Release the verified SOR readiness change over the current application image."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/sor-return-unblocked-20261016'
RELEASE = SERVER / 'deployments/sor-return-unblocked-20261016'
FILE = 'src/sor-return-readiness.js'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:sor-return-unblocked-20261016'
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata = core.docker, core.metadata


def digest(content):
    return hashlib.sha256(content).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def compose(state, override):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in state['app']['configFiles'].split(','):
        args += ['-f', file]
    return args + ['-f', str(RELEASE / override)]


def evidence():
    report = (OUT / 'green-tests.log').read_text()
    assert '# fail 0\n' in report and '# skipped 0\n' in report
    assert digest((SERVER / FILE).read_bytes()) == (OUT / 'tested-source-sha256.txt').read_text().strip()
    assert json.loads((OUT / 'green-health.json').read_text())['ok'] is True
    assert 'mbbs-sor-return-unblocked-20261016' not in (OUT / 'green-docker-ps-a.txt').read_text()


def current(state):
    assert metadata(APP) == state['app'], 'Live application changed since capture'
    assert [metadata(name) for name in DEPENDENCIES] == state['dependencies']
    assert digest(docker('exec', APP, 'cat', '/app/' + FILE)) == state['before']
    assert digest((SERVER / FILE).read_bytes()) == state['after']


def readiness():
    script = b"import {getSorReturnReadiness} from './src/sor-return-readiness.js';import {closeDb} from './src/db.js';try{console.log(JSON.stringify(await getSorReturnReadiness(['SOR00225-Return'])));}finally{await closeDb();}"
    return json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=script))


def prepare():
    evidence()
    assert not (RELEASE / 'manifest.json').exists(), 'Release already prepared'
    state = {'app': metadata(APP), 'dependencies': [metadata(name) for name in DEPENDENCIES]}
    assert state['app']['imageId'] == (OUT / 'base-image.txt').read_text().strip()
    before = docker('exec', APP, 'cat', '/app/' + FILE)
    assert before == (RELEASE / 'before' / FILE).read_bytes()
    after = (SERVER / FILE).read_bytes()
    state.update(before=digest(before), after=digest(after), readinessBefore=readiness())
    candidate = RELEASE / 'candidate'
    (candidate / FILE).parent.mkdir(parents=True, exist_ok=True)
    (candidate / FILE).write_bytes(after)
    base_tag = 'mbbs-operator-app:sor-return-unblocked-base-' + state['app']['imageId'].split(':')[-1][:12]
    docker('tag', state['app']['imageId'], base_tag)
    (candidate / 'Dockerfile').write_text('FROM ' + base_tag + '\nCOPY --chown=node:node ' + FILE + ' /app/' + FILE + '\n')
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    current(state)
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(candidate)],
                       check=True, stdout=log, stderr=subprocess.STDOUT, timeout=120)
    state['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    before_config = json.loads(subprocess.check_output(compose(state, 'compose.rollback.yml') + ['config', '--format', 'json'], cwd=ROOT))
    after_config = json.loads(subprocess.check_output(compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    before_config['services']['app'].pop('image')
    assert after_config['services']['app'].pop('image') == IMAGE
    assert before_config == after_config, 'Unexpected Compose configuration change'
    save('manifest.json', state)
    print(json.dumps({'prepared': True, 'files': [FILE], 'readinessBefore': state['readinessBefore']}), flush=True)


def verify(state):
    core.ready(state['candidateImageId'])
    assert metadata(APP)['configuration'] == state['app']['configuration']
    assert [metadata(name) for name in DEPENDENCIES] == state['dependencies']
    assert digest(docker('exec', APP, 'cat', '/app/' + FILE)) == state['after']
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': IMAGE, 'sourceHash': state['after'], 'readinessAfter': readiness(),
              'configurationPreserved': True, 'dependenciesUnchanged': True, 'migrations': 0,
              'dockerPs': docker('ps', '--format', '{{.Names}} {{.Status}}').decode(),
              'dockerPsA': docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode()}
    assert result['readinessAfter'] == [{'orderRef': 'SOR00225-Return', 'parentOrderRef': 'SOR00225',
                                       'allowed': True, 'code': '', 'message': ''}]
    save('deployment-result.json', result)
    (OUT / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key not in {'dockerPs', 'dockerPsA'}}), flush=True)


def apply():
    state = json.loads((RELEASE / 'manifest.json').read_text())
    evidence()
    current(state)
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == state['candidateImageId']
    resolved = json.loads(subprocess.check_output(compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    image_config = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    runtime = json.loads(docker('inspect', APP))[0]['Config']
    environment = dict(entry.split('=', 1) for entry in image_config['Env'])
    environment.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert environment == dict(entry.split('=', 1) for entry in runtime['Env']), 'Environment would change'
    for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        assert (resolved.get(option) if resolved.get(option) is not None else image_config.get(field)) == runtime.get(field)
    active = docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=b"import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(\"SELECT count(*)::int AS n FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')\")).rows[0]));}finally{await closeDb();}")
    assert json.loads(active)['n'] == 0, 'An Operator posting is in progress'
    current(state)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(compose(state, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify(state)
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(compose(state, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        save('rollback-result.json', {'previousAppRestored': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply}[sys.argv[1]]()
