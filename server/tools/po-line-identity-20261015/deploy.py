"""Overlay the verified lookup onto the current application image, with rollback."""
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
TASK = Path(__file__).resolve().parent
OUT = SERVER / 'test-artifacts/po-line-identity-20261015'
STAGE = sys.argv[1]
assert STAGE in ['record', 'general']
RELEASE = SERVER / ('deployments/po-line-identity-' + STAGE + '-20261015')
FILE = 'src/dispatch-order-target-repository.js'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:po-line-identity-' + STAGE + '-20261015'
module = importlib.util.spec_from_file_location('po_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(module)
module.loader.exec_module(core)
docker, metadata = core.docker, core.metadata


def digest(content):
    return hashlib.sha256(content).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def current(data):
    assert metadata(APP) == data['app'], 'Application changed; rebase release before publishing'
    assert [metadata(name) for name in DEPENDENCIES] == data['dependencies'], 'Dependency changed'
    assert digest((SERVER / FILE).read_bytes()) == data['after'], 'Verified source changed'
    assert digest(docker('exec', APP, 'cat', '/app/' + FILE)) == data['before'], 'Live file changed'


def compose(data, override):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for filename in data['app']['configFiles'].split(','):
        args += ['-f', filename]
    return args + ['-f', str(RELEASE / override), '--env-file', str(ROOT / 'docker/env/.env')]


def evidence():
    filename = 'record-green.json' if STAGE == 'record' else 'final.json'
    check = json.loads((OUT / filename).read_text())
    assert check['exitCode'] == 0 and not check['failures'], 'Regression checks failed'
    assert check['sourceHash'] == digest((SERVER / FILE).read_bytes()), 'Source changed since checks'
    if STAGE == 'general':
        assert check['completeGauntlet'] is True
    return check


def prepare():
    evidence()
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    data = {'app': metadata(APP), 'dependencies': [metadata(name) for name in DEPENDENCIES]}
    before = docker('exec', APP, 'cat', '/app/' + FILE)
    after = (SERVER / FILE).read_bytes()
    expected = (OUT / 'baseline' / FILE).read_bytes() if STAGE == 'record' else (OUT / 'record-release.js').read_bytes()
    assert before == expected, 'Live baseline changed since verification'
    data.update(before=digest(before), after=digest(after))
    for folder, content in [('before', before), ('candidate', after)]:
        target = RELEASE / folder / FILE
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    save('manifest.json', data)
    current(data)
    tag = 'mbbs-operator-app:po-line-identity-' + STAGE + '-base-20261015'
    docker('tag', data['app']['imageId'], tag)
    (RELEASE / 'candidate/Dockerfile').write_text('FROM ' + tag + '\nCOPY --chown=node:node ' + FILE + ' /app/' + FILE + '\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', IMAGE,
            str(RELEASE / 'candidate')], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    data['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    for name, image in [('compose.release.yml', IMAGE), ('compose.rollback.yml', data['app']['imageId'])]:
        (RELEASE / name).write_text('services:\n  app:\n    image: ' + image + '\n')
    save('manifest.json', data)
    before_config = json.loads(subprocess.check_output(compose(data, 'compose.rollback.yml') + ['config', '--format', 'json']))
    after_config = json.loads(subprocess.check_output(compose(data, 'compose.release.yml') + ['config', '--format', 'json']))
    before_config['services']['app'].pop('image')
    assert after_config['services']['app'].pop('image') == IMAGE
    assert before_config == after_config, 'Runtime configuration would change'
    name = 'mbbs-po-line-candidate-' + STAGE
    # Register removal before creating this bounded one-off check.
    try:
        docker('run', '--rm', '--init', '--read-only', '--network=none', '--name', name,
            '--cgroup-parent=mbbs-tests.slice', '--memory=256m', '--memory-swap=256m', '--cpus=1',
            '--pids-limit=64', '--tmpfs', '/tmp:size=32m', '--label', 'com.mbbs.lifecycle=disposable-test',
            '--entrypoint', 'node', IMAGE, '--check', FILE)
    finally:
        remaining = docker('ps', '-aq', '--filter', 'name=^/' + name + '$').decode().split()
        if remaining:
            docker('rm', '-f', '-v', *remaining)
        save('prepare-cleanup.json', {'dockerPs': docker('ps', '--format', '{{.Names}} {{.Status}}').decode(),
            'dockerPsA': docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode()})
    save('prepared.json', {'candidateImageId': data['candidateImageId'], 'sourceHash': data['after']})
    print(json.dumps({'prepared': True, 'stage': STAGE, 'imageId': data['candidateImageId']}), flush=True)


def verify():
    data = state()
    core.ready(data['candidateImageId'])
    actual = metadata(APP)
    assert actual['configuration'] == data['app']['configuration'], 'Configuration drift'
    assert [metadata(name) for name in DEPENDENCIES] == data['dependencies'], 'Other service changed'
    assert digest(docker('exec', APP, 'cat', '/app/' + FILE)) == data['after']
    live = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module',
        input=(TASK / 'live.mjs').read_bytes()))
    result = {'deployed': True, 'stage': STAGE, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'imageId': actual['imageId'], 'sourceHash': data['after'], 'onlyAppChanged': True, **live}
    save('deployment-result.json', result)
    (OUT / (STAGE + '-deployment.json')).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    evidence()
    current(data)
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    config = json.loads(subprocess.check_output(compose(data, 'compose.release.yml') + ['config', '--format', 'json']))['services']['app']
    image_config = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    live_config = json.loads(docker('inspect', APP))[0]['Config']
    expected_env = dict(entry.split('=', 1) for entry in image_config['Env'])
    expected_env.update({key: str(value) for key, value in config.get('environment', {}).items()})
    assert expected_env == dict(entry.split('=', 1) for entry in live_config['Env']), 'Environment drift'
    busy = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=b"import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(\"SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing') AS count\")).rows[0]));}finally{await closeDb();}"))
    assert int(busy['count']) == 0, 'An operation is executing; defer restart'
    current(data)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(compose(data, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(data['app']['imageId'])
        save('rollback-result.json', {'previousAppRestored': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[2]]()
