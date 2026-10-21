"""Release only the linked-group structure comparison over the current app."""
import difflib
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/linked-group-plan-save-20261001'
RELEASE = SERVER / 'deployments/linked-group-plan-save-20261001'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
FILE = 'src/server.js'
IMAGE = 'mbbs-operator-app:linked-group-plan-save-20261001'
spec = importlib.util.spec_from_file_location('linked_group_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata = core.docker, core.metadata

TREE_SCRIPT = """import {readdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files={};
function visit(path){for(const entry of readdirSync(path,{withFileTypes:true})){
 const child=path+'/'+entry.name;if(entry.isDirectory())visit(child);
 else if(entry.isFile())files[child]=createHash('sha256').update(readFileSync(child)).digest('hex');
}}
for(const directory of ['src','public','migrations'])visit(directory);
for(const file of ['package.json','package-lock.json'])files[file]=createHash('sha256').update(readFileSync(file)).digest('hex');
console.log(JSON.stringify(files));"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def current(data):
    assert metadata(APP) == data['before'], 'Live app changed: recapture the scoped release'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Another service changed'
    assert digest(SERVER / FILE) == data['workspaceHash'], 'Workspace source changed'
    assert digest(RELEASE / 'candidate' / FILE) == data['sourceHash'], 'Candidate source changed'
    actual = hashlib.sha256(docker('exec', APP, 'cat', '/app/' + FILE)).hexdigest()
    assert actual == data['treeBefore'][FILE], 'Live source changed'


def capture():
    RELEASE.mkdir(exist_ok=False)
    before = metadata(APP)
    data = {'before': before, 'dependencies': {name: metadata(name) for name in DEPENDENCIES},
            'workspaceHash': digest(SERVER / FILE), 'image': IMAGE}
    old = RELEASE / 'before' / FILE
    old.parent.mkdir(parents=True)
    old.write_bytes(docker('exec', APP, 'cat', '/app/' + FILE))
    data['treeBefore'] = json.loads(docker('exec', APP, 'node', '--input-type=module', '-e', TREE_SCRIPT))
    target = RELEASE / 'candidate' / FILE
    target.parent.mkdir(parents=True)
    shutil.copy2(old, target)
    patch = ''.join(difflib.unified_diff((OUT / 'before' / FILE).read_text().splitlines(True),
        (SERVER / FILE).read_text().splitlines(True), fromfile='a/' + FILE, tofile='b/' + FILE))
    (RELEASE / 'workspace.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(RELEASE / 'candidate')],
                            input=patch, text=True, capture_output=True)
    (RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Scoped patch needs rebase: inspect patch.log'
    for path in (RELEASE / 'candidate').rglob('*.orig'):
        path.unlink()
    data['sourceHash'] = digest(target)
    assert data['sourceHash'] == data['workspaceHash'], 'Rebased candidate must be verified separately'
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'parent': before['image'], 'files': [FILE]}), flush=True)


def recapture():
    for revision in range(1, 100):
        backup = RELEASE.with_name(RELEASE.name + '-capture-' + str(revision))
        if not backup.exists():
            RELEASE.rename(backup)
            capture()
            return
    raise RuntimeError('No unused capture backup path')


def prepare():
    data = state()
    current(data)
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['passed'] and checks['sourceHashes'] == {FILE: data['sourceHash']}, 'Exact candidate checks required'
    stage = RELEASE / 'stage'
    overlay = stage / 'overlay' / FILE
    overlay.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(RELEASE / 'candidate' / FILE, overlay)
    parent = 'mbbs-operator-app:linked-group-parent-' + data['before']['imageId'].removeprefix('sha256:')
    docker('image', 'tag', data['before']['imageId'], parent)
    assert docker('image', 'inspect', '--format', '{{.Id}}', parent).decode().strip() == data['before']['imageId']
    data['parentImage'] = parent
    (stage / 'Dockerfile').write_text('FROM ' + parent + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    data['imageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    tree = json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE,
                            '--input-type=module', '-e', TREE_SCRIPT))
    expected = {**data['treeBefore'], FILE: data['sourceHash']}
    assert tree == expected, 'Release changed files outside the scoped fix'
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent',
           '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
           '--entrypoint', 'node', IMAGE, '--input-type=module', '-e',
           "await import('./src/server.js'); process.exit(0)")
    for kind, image in [('release', IMAGE), ('rollback', data['before']['imageId'])]:
        (RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'image': IMAGE, 'imageId': data['imageId'], 'scopeVerified': True}), flush=True)


def preflight():
    data = state()
    current(data)
    script = (SERVER / 'tools/linked-group-plan-save-live.mjs').read_text()
    anchor = "const source = readFileSync('src/server.js', 'utf8');"
    assert script.count(anchor) == 1
    script = script.replace(anchor, 'const source = ' + json.dumps((RELEASE / 'candidate' / FILE).read_text()) + ';')
    probe = json.loads(docker('exec', '-i', '-e', 'LINKED_GROUP_READ_ONLY=1', '-e', 'LINKED_GROUP_EXPECT_FIXED=1',
        APP, 'node', '--input-type=module', input=script.encode()))
    assert probe['passed'] and probe['readOnly'] and probe['sourceHash'] == data['sourceHash']
    (OUT / 'live-candidate-preflight.json').write_text(json.dumps(probe, indent=2) + '\n')
    print(json.dumps({'candidateValidatedReadOnly': True, 'structureError': probe['structureError'],
                     'dependencyConflicts': probe['groupTimingConflicts'], 'allocationsUnchanged': True}), flush=True)


def publish():
    data = state()
    current(data)
    assert json.loads((OUT / 'regression-comparison.json').read_text())['passed'], 'Full regression comparison required'
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['passed'] and checks['sourceHashes'] == {FILE: data['sourceHash']}
    args = ['sudo', '-n', 'docker', 'compose', '--project-directory', str(ROOT),
            '--env-file', str(ROOT / 'docker/env/.env')]
    for config in data['before']['configFiles'].split(','):
        args.extend(['-f', config])
    try:
        subprocess.run(args + ['-f', str(RELEASE / 'compose.release.yml'), 'up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        core.ready(data['imageId'])
        after = metadata(APP)
        assert after['configuration'] == data['before']['configuration']
        assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
        tree = json.loads(docker('exec', APP, 'node', '--input-type=module', '-e', TREE_SCRIPT))
        assert tree == {**data['treeBefore'], FILE: data['sourceHash']}
        probe = json.loads(docker('exec', '-i', '-e', 'LINKED_GROUP_READ_ONLY=1', '-e', 'LINKED_GROUP_EXPECT_FIXED=1',
            APP, 'node', '--input-type=module', input=(SERVER / 'tools/linked-group-plan-save-live.mjs').read_bytes()))
        assert probe['passed'] and probe['readOnly'] and probe['sourceHash'] == data['sourceHash']
        (OUT / 'live-final.json').write_text(json.dumps(probe, indent=2) + '\n')
        save('published.json', {'healthy': True, 'image': IMAGE, 'imageId': after['imageId'],
             'configurationPreserved': True, 'dependenciesUnchanged': True, 'scopeVerified': True,
             'liveDraftVerifiedReadOnly': True, 'after': after})
        print(json.dumps({'published': True, 'healthy': True, 'image': IMAGE, 'readOnlyDraftVerified': True}), flush=True)
    except Exception:
        subprocess.run(args + ['-f', str(RELEASE / 'compose.rollback.yml'), 'up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        core.ready(data['before']['imageId'])
        save('rollback.json', {'rolledBack': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'recapture': recapture, 'prepare': prepare, 'preflight': preflight, 'publish': publish}[sys.argv[1]]()
