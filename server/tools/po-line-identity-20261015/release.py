"""Publish only the verified files over the captured live image, with rollback."""
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
RELEASE = SERVER / 'deployments/po-line-identity-general-20261015'
FILES = ['src/dispatch-order-target-repository.js', 'src/dispatch-delivery-group-repository.js',
    'public/dispatch.js', 'public/dispatch.html', 'public/mbt-planning.html']
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:po-line-identity-general-20261015'
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


def evidence():
    check = json.loads((OUT / 'final.json').read_text())
    assert check['exitCode'] == 0 and check['completeGauntlet'] and not check['failures']
    assert all(digest((OUT / 'candidate' / filename).read_bytes()) == check['hashes'][filename] for filename in FILES)
    cleanup = json.loads((OUT / 'cleanup-final.json').read_text())
    assert cleanup['teardownExit'] == 0 and cleanup['productionHealthy'] and not cleanup['taskContainers']
    replay = json.loads((OUT / 'history-replay-summary.json').read_text())
    assert replay['passed'] and replay['unexpectedDifferences'] == 0
    assert replay['candidateSourceHashes'] == check['hashes'], 'History replay is stale'
    for mode in ['history-baseline', 'history-candidate']:
        disposed = json.loads((OUT / ('cleanup-' + mode + '.json')).read_text())
        assert disposed['teardownExit'] == 0 and disposed['productionHealthy']
        assert not disposed['taskContainers'] and not disposed['networks'] and not disposed['volumes']
    return check


def current(data):
    assert metadata(APP) == data['app'], 'Live release changed; recapture and verify before deployment'
    assert [metadata(name) for name in DEPENDENCIES] == data['dependencies'], 'Dependency changed'
    for filename in FILES:
        assert digest(docker('exec', APP, 'cat', '/app/' + filename)) == data['before'][filename]
        assert digest((OUT / 'candidate' / filename).read_bytes()) == data['after'][filename]


def compose(data, filename):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for config in data['app']['configFiles'].split(','):
        args += ['-f', config]
    return args + ['-f', str(RELEASE / filename), '--env-file', str(ROOT / 'docker/env/.env')]


def prepare():
    verified = evidence()
    capture = json.loads((OUT / 'runtime-capture.json').read_text())
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    data = {'app': metadata(APP), 'dependencies': [metadata(name) for name in DEPENDENCIES],
        'before': capture['before'], 'after': verified['hashes'], 'files': FILES}
    assert data['app']['imageId'] == capture['imageId'], 'Application changed since the tested capture'
    current(data)
    for filename in FILES:
        for folder, source in [('before', OUT / 'runtime-baseline'), ('candidate', OUT / 'candidate')]:
            target = RELEASE / folder / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((source / filename).read_bytes())
    tag = 'mbbs-operator-app:rollback-po-line-identity-general-20261015'
    docker('tag', data['app']['imageId'], tag)
    (RELEASE / 'candidate/Dockerfile').write_text('FROM ' + tag + '\n' + ''.join(
        'COPY --chown=node:node ' + filename + ' /app/' + filename + '\n' for filename in FILES))
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '--network=none', '-t', IMAGE,
            str(RELEASE / 'candidate')], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    data['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    for name, image in [('compose.release.yml', IMAGE), ('compose.rollback.yml', data['app']['imageId'])]:
        (RELEASE / name).write_text('services:\n  app:\n    image: ' + image + '\n')
    save('manifest.json', data)
    before = json.loads(subprocess.check_output(compose(data, 'compose.rollback.yml') + ['config', '--format', 'json']))
    after = json.loads(subprocess.check_output(compose(data, 'compose.release.yml') + ['config', '--format', 'json']))
    before['services']['app'].pop('image')
    assert after['services']['app'].pop('image') == IMAGE
    assert before == after, 'Compose settings would change'
    name = 'mbbs-po-line-general-release-check'
    # Register exact-container teardown before this bounded one-off check.
    try:
        script = "const fs=require('fs'),crypto=require('crypto'),cp=require('child_process');const files=" + json.dumps(data['after']) + ";for(const [f,h]of Object.entries(files)){if(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')!==h)throw Error(f);if(f.endsWith('.js')&&cp.spawnSync(process.execPath,['--check',f]).status)process.exit(1);}"
        docker('run', '--rm', '--init', '--read-only', '--network=none', '--name', name,
            '--cgroup-parent=mbbs-tests.slice', '--memory=256m', '--memory-swap=256m', '--cpus=1',
            '--pids-limit=64', '--tmpfs', '/tmp:size=32m', '--label', 'com.mbbs.lifecycle=disposable-test',
            '--entrypoint', 'node', IMAGE, '-e', script)
    finally:
        remaining = docker('ps', '-aq', '--filter', 'name=^/' + name + '$').decode().split()
        if remaining:
            docker('rm', '-f', '-v', *remaining)
        save('prepare-cleanup.json', {'dockerPs': docker('ps', '--format', '{{.Names}} {{.Status}}').decode(),
            'dockerPsA': docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode()})
    current(data)
    save('prepared.json', {'candidateImageId': data['candidateImageId'], 'files': FILES})
    print(json.dumps({'prepared': True, 'imageId': data['candidateImageId'], 'files': FILES}), flush=True)


def verify():
    data = state()
    core.ready(data['candidateImageId'])
    actual = metadata(APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [metadata(name) for name in DEPENDENCIES] == data['dependencies']
    for filename in FILES:
        assert digest(docker('exec', APP, 'cat', '/app/' + filename)) == data['after'][filename]
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=(TASK / 'live.mjs').read_bytes()))
    asset = "import assert from 'node:assert/strict';import {createHash} from 'node:crypto';const r=await fetch('http://127.0.0.1:3000/dispatch.js?v=20261015-po-lines-ungroup-v1');assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex')," + json.dumps(data['after']['public/dispatch.js']) + ");console.log(JSON.stringify({assetMatches:true}));"
    http = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=asset.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'imageId': actual['imageId'],
        'files': data['after'], 'configurationPreserved': True, 'onlyAppChanged': True, 'live': live, 'http': http,
        'dockerPs': docker('ps', '--format', '{{.Names}} {{.Status}}').decode(),
        'dockerPsA': docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode()}
    save('deployment-result.json', result)
    (OUT / 'general-deployment.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ['dockerPs', 'dockerPsA']}), flush=True)


def apply():
    data = state()
    evidence()
    current(data)
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    resolved = json.loads(subprocess.check_output(compose(data, 'compose.release.yml') + ['config', '--format', 'json']))['services']['app']
    image_config = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    live_config = json.loads(docker('inspect', APP))[0]['Config']
    expected_env = dict(entry.split('=', 1) for entry in image_config['Env'])
    expected_env.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert expected_env == dict(entry.split('=', 1) for entry in live_config['Env'])
    busy = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=(TASK / 'release-busy.mjs').read_bytes()))
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
        save('rollback-result.json', {'previousApplicationRestored': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
