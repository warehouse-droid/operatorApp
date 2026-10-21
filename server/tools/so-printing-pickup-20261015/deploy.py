"""Publish only the tested printing changes, preserving the current live image."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/so-printing-pickup-20261015'
RELEASE = SERVER / 'deployments/so-printing-pickup-20261015'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:so-printing-pickup-20261015'
FILES = json.loads((TASK / 'capture.json').read_text())['files']
spec = importlib.util.spec_from_file_location('printing_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata = core.docker, core.metadata


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(name, data):
    (RELEASE / name).write_text(json.dumps(data, indent=2) + '\n')


def compose(state, file):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for config in state['app']['configFiles'].split(','):
        args += ['-f', config]
    return args + ['-f', str(RELEASE / file)]


def current(state):
    assert metadata(APP) == state['app'], 'Live app changed; prepare again to preserve concurrent work'
    assert [metadata(name) for name in DEPENDENCIES] == state['dependencies']
    for file in FILES:
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == state['before'][file]
        assert digest((TASK / 'candidate' / file).read_bytes()) == state['after'][file]


def prepare():
    assert '# fail 0' in (OUT / 'pickup-integration.log').read_text()
    assert 'Sales portal access checks passed.' in (OUT / 'sales-portal-regression.log').read_text()
    cleanup = json.loads((OUT / 'cleanup.json').read_text())
    assert cleanup['teardownExit'] == 0 and cleanup['productionHealthy']
    assert not cleanup['ownContainers'] and not cleanup['networks'] and not cleanup['volumes']
    state = {'app': metadata(APP), 'dependencies': [metadata(name) for name in DEPENDENCIES], 'before': {}, 'after': {}}
    for file in FILES:
        before = docker('exec', APP, 'cat', '/app/' + file)
        assert before == (TASK / 'baseline' / file).read_bytes(), 'Printing source changed: ' + file
        after = (TASK / 'candidate' / file).read_bytes()
        state['before'][file], state['after'][file] = digest(before), digest(after)
        for folder, content in [('before', before), ('candidate', after)]:
            dest = RELEASE / folder / file
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)
    state['baseTag'] = 'mbbs-operator-app:so-printing-pickup-base-' + state['app']['imageId'].split(':')[-1][:12]
    (RELEASE / 'candidate/Dockerfile').write_text('FROM ' + state['baseTag'] + '\n' + ''.join(
        'COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in FILES))
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    current(state)
    docker('tag', state['app']['imageId'], state['baseTag'])
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '--network=none', '-t', IMAGE, str(RELEASE / 'candidate')],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    state['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    before_config = json.loads(subprocess.check_output(compose(state, 'compose.rollback.yml') + ['config', '--format', 'json'], cwd=ROOT))
    after_config = json.loads(subprocess.check_output(compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    before_config['services']['app'].pop('image')
    assert after_config['services']['app'].pop('image') == IMAGE
    assert before_config == after_config, 'Unexpected configuration changes'
    save('manifest.json', state)
    print(json.dumps({'prepared': True, 'files': FILES, 'baseImage': state['app']['image']}), flush=True)


def verify(state):
    core.ready(state['candidateImageId'])
    actual = metadata(APP)
    assert actual['configuration'] == state['app']['configuration']
    assert [metadata(name) for name in DEPENDENCIES] == state['dependencies']
    for file in FILES:
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == state['after'][file]
    # Read-only operational verification. Never queue a physical print job.
    live = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=(TASK / 'live.mjs').read_bytes()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'image': IMAGE, 'runtimeHashes': state['after'], 'configurationPreserved': True,
        'dependenciesUnchanged': True, 'databaseMigrations': 0, **live,
        'dockerPs': docker('ps', '--format', '{{.Names}} {{.Status}}').decode(),
        'dockerPsA': docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode()}
    save('deployment-result.json', result)
    (OUT / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ['dockerPs', 'dockerPsA', 'runtimeHashes']}), flush=True)


def apply():
    state = json.loads((RELEASE / 'manifest.json').read_text())
    current(state)
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == state['candidateImageId']
    resolved = json.loads(subprocess.check_output(compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    image_config = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    runtime_config = json.loads(docker('inspect', APP))[0]['Config']
    expected_env = dict(entry.split('=', 1) for entry in image_config['Env'])
    expected_env.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert expected_env == dict(entry.split('=', 1) for entry in runtime_config['Env']), 'Environment would change'
    for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        assert (resolved.get(option) if resolved.get(option) is not None else image_config.get(field)) == runtime_config.get(field)
    active = docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=b"import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(\"SELECT count(*)::int AS count FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')\")).rows[0]));}finally{await closeDb();}")
    assert json.loads(active)['count'] == 0, 'Operator posting in progress'
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
