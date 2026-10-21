"""Publish the first-split group status correction over the current live image."""
import difflib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/first-split-group-status-20261001'
RELEASE = SERVER / 'deployments/first-split-group-status-20261001'
APP = 'mbbs-operator-app-app-1'
UNTOUCHED = ['mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
FILES = ['src/dispatch-fulfilled-so-repository.js', 'public/dispatch.js', 'public/dispatch.html']
IMAGE = 'mbbs-operator-app:first-split-group-status-20261001'
spec = importlib.util.spec_from_file_location('goa_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata, files_at = core.docker, core.metadata, core.files_at


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def current(data):
    assert metadata(APP) == data['before'], 'Live app changed; recapture this scoped patch'
    assert {name: metadata(name) for name in UNTOUCHED} == data['untouched'], 'Another service changed'
    assert {file: digest(SERVER / file) for file in FILES} == data['workspaceHashes'], 'Workspace changed'
    assert files_at(RELEASE / 'candidate') == data['sourceTree'], 'Candidate changed'
    live = docker('exec', APP, 'sha256sum', *['/app/' + file for file in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in live} == {
        file: digest(RELEASE / 'before' / file) for file in FILES}, 'Live source changed since capture'


def capture():
    RELEASE.mkdir(exist_ok=False)
    before = metadata(APP)
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for folder in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + folder, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    assert metadata(APP) == before
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''.join(''.join(difflib.unified_diff((OUT / 'before' / file).read_text().splitlines(True),
        (SERVER / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file)) for file in FILES)
    (RELEASE / 'workspace.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch,
                            text=True, capture_output=True)
    (RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Inspect patch.log: live source differs from the feature baseline'
    for path in candidate.rglob('*.orig'):
        path.unlink()
    old, new = files_at(baseline), files_at(candidate)
    changed = sorted(file for file in new if old.get(file) != new[file])
    assert changed == sorted(FILES), changed
    data = {'before': before, 'untouched': {name: metadata(name) for name in UNTOUCHED},
            'workspaceHashes': {file: digest(SERVER / file) for file in FILES}, 'sourceTree': new,
            'sourceHashes': {file: new[file] for file in FILES}, 'image': IMAGE}
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'parent': before['image'], 'changed': changed,
                      'matchesWorkspace': {file: new[file] == data['workspaceHashes'][file] for file in FILES}}))


def prepare():
    data = state()
    current(data)
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['passed'], 'Focused verification required before image build'
    assert checks['sourceHashes'] == {file: data['sourceHashes'][file] for file in FILES if file.endswith('.js')}, 'Checks must match the exact release source'
    stage = RELEASE / 'stage'
    for file in FILES:
        target = stage / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / file, target)
    assert docker('image', 'inspect', '--format', '{{.Id}}', data['before']['image']).decode().strip() == data['before']['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + data['before']['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    data['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    for file in FILES:
        assert hashlib.sha256(docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', IMAGE, '/app/' + file)).hexdigest() == data['sourceHashes'][file]
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
           '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', IMAGE, '--input-type=module', '-e',
           "await import('./src/server.js'); process.exit(0)")
    for kind, image in [('release', IMAGE), ('rollback', data['before']['imageId'])]:
        (RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'imageId': data['candidateImageId']}))


def publish():
    data = state()
    current(data)
    assert json.loads((OUT / 'checks.json').read_text())['passed'], 'Focused regression verification required before publishing'
    configs = data['before']['configFiles'].split(',')
    args = ['sudo', '-n', 'docker', 'compose', '--project-directory', str(ROOT),
            '--env-file', str(ROOT / 'docker/env/.env')]
    for config in configs:
        args.extend(['-f', config])
    try:
        subprocess.run(args + ['-f', str(RELEASE / 'compose.release.yml'), 'up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        core.ready(data['candidateImageId'])
        after = metadata(APP)
        assert after['configuration'] == data['before']['configuration']
        assert {name: metadata(name) for name in UNTOUCHED} == data['untouched']
        for file in FILES:
            assert hashlib.sha256(docker('exec', APP, 'cat', '/app/' + file)).hexdigest() == data['sourceHashes'][file]
        probe = json.loads(docker('exec', '-i', '-e', 'FIRST_SPLIT_READ_ONLY=1', APP,
            'node', '--input-type=module', input=(SERVER / 'tools/first-split-group-status-live.mjs').read_bytes()))
        assert probe['passed'] and probe['readOnly'], 'Read-only live order verification required'
        (OUT / 'live.json').write_text(json.dumps(probe, indent=2) + '\n')
        save('published.json', {'healthy': True, 'after': after, 'unchangedServices': True, 'liveOrderVerified': True})
        print(json.dumps({'published': True, 'image': IMAGE, 'healthy': True}))
    except Exception:
        subprocess.run(args + ['-f', str(RELEASE / 'compose.rollback.yml'), 'up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        core.ready(data['before']['imageId'])
        save('rollback.json', {'rolledBack': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'publish': publish}[sys.argv[1]]()
