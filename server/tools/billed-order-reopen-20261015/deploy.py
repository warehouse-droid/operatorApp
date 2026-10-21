"""Release only the verified billed-order fix over the captured live image."""
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
RELEASE = SERVER / 'deployments/billed-order-reopen-20261015'
EVIDENCE = SERVER / 'test-artifacts/billed-order-reopen-20261015'
FILES = ['src/operator-order-reopen-repository.js', 'public/dispatch.js', 'public/dispatch.html']
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1', 'mbbs-operator-app-webhook-worker-1']
IMAGE = 'mbbs-operator-app:billed-order-reopen-20261015'
spec = importlib.util.spec_from_file_location('billed_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
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
    summary = json.loads((EVIDENCE / 'summary.json').read_text())
    assert not summary['newFailures'] and summary['fail'] == len(summary['baselineFailures'])
    assert summary['pass'] + summary['fail'] == summary['tests']
    for file, expected in summary['hashes'].items():
        path = TASK / 'candidate' / file if file in FILES else SERVER / file
        assert digest(path.read_bytes()) == expected, 'Changed after verification: ' + file
    static = json.loads((EVIDENCE / 'static.json').read_text())
    assert not static['newTypes'] and not static['newLint']
    coverage = json.loads((EVIDENCE / 'changed-coverage.json').read_text())
    assert not coverage['missing']
    mutants = json.loads((EVIDENCE / 'mutations.json').read_text())
    assert len(mutants) == 5 and all(row['killed'] for row in mutants)
    cleanup = json.loads((EVIDENCE / 'cleanup-final.json').read_text())
    assert cleanup['teardownExit'] == 0 and cleanup['productionHealthy'] and not cleanup['ownTestContainers']
    return summary

def current(data):
    assert metadata(APP) == data['app'], 'Live application changed; recapture before release'
    assert [metadata(name) for name in DEPENDENCIES] == data['dependencies'], 'Another service changed'
    for file in FILES:
        assert digest((TASK / 'candidate' / file).read_bytes()) == data['after'][file]
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == data['before'][file]

def compose(data, filename):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in data['app']['configFiles'].split(','):
        args += ['-f', file]
    return args + ['-f', str(RELEASE / filename)]

def listings():
    return {'dockerPs': docker('ps', '--format', '{{.Names}} {{.Status}}').decode(),
            'dockerPsA': docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode(),
            'testContainers': docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}').decode().strip()}

def prepare():
    evidence()
    RELEASE.mkdir(parents=True, exist_ok=True)
    data = {'app': metadata(APP), 'dependencies': [metadata(name) for name in DEPENDENCIES], 'before': {}, 'after': {}}
    assert data['app']['imageId'] == json.loads((TASK / 'capture.json').read_text())['imageId']
    for file in FILES:
        before = docker('exec', APP, 'cat', '/app/' + file)
        assert before == (TASK / 'baseline' / file).read_bytes(), 'Live file changed: ' + file
        after = (TASK / 'candidate' / file).read_bytes()
        data['before'][file], data['after'][file] = digest(before), digest(after)
        for folder, content in [('before', before), ('candidate', after)]:
            path = RELEASE / folder / file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    data['baseImageTag'] = 'mbbs-operator-app:billed-reopen-base-' + data['app']['imageId'].split(':')[-1][:12]
    (RELEASE / 'candidate/Dockerfile').write_text('FROM ' + data['baseImageTag'] + '\n' + ''.join(
        'COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in FILES))
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + data['app']['imageId'] + '\n')
    save('manifest.json', data)
    current(data)
    docker('tag', data['app']['imageId'], data['baseImageTag'])
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '--network=none', '-t', IMAGE, str(RELEASE / 'candidate')],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    data['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    save('manifest.json', data)
    before_config = json.loads(subprocess.check_output(compose(data, 'compose.rollback.yml') + ['config', '--format', 'json'], cwd=ROOT))
    after_config = json.loads(subprocess.check_output(compose(data, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    before_config['services']['app'].pop('image', None)
    assert after_config['services']['app'].pop('image') == IMAGE
    assert before_config == after_config, 'Compose configuration would change'
    save('prepared.json', {'candidateImageId': data['candidateImageId'], 'files': FILES, 'configurationPreserved': True})
    print(json.dumps({'prepared': True, 'files': FILES, 'imageId': data['candidateImageId']}), flush=True)

def verify():
    data = state()
    core.ready(data['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == data['candidateImageId']
    assert actual['configuration'] == data['app']['configuration']
    assert [metadata(name) for name in DEPENDENCIES] == data['dependencies']
    for file in FILES:
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == data['after'][file]
    live = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=(TASK / 'live.mjs').read_bytes()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': actual['imageId'], 'runtimeHashes': data['after'], 'onlyAppChanged': True,
              'configurationPreserved': True, 'databaseMigrations': 0, **listings(), **live}
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
        assert (resolved.get(option) if resolved.get(option) is not None else image_config.get(field)) == runtime_config.get(field)
    active = docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=b"import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(\"SELECT count(*)::int AS count FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')\")).rows[0]));}finally{await closeDb();}")
    assert json.loads(active)['count'] == 0, 'Operator posting is in progress'
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
