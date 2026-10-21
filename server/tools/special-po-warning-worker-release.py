"""Release the approved-local-adjustment PO unblock on the captured application image."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
r.RELEASE = SERVER / 'deployments/special-po-warning-worker-20261019'
r.IMAGE = 'mbbs-operator-app:special-po-warning-worker-20261019'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-special-po-warning-worker-reader'
r.CHECK_NAME = 'mbbs-special-po-warning-worker-check'
r.APP = 'mbbs-operator-app-webhook-worker-1'
r.DEPENDENCIES = [r.DB, 'mbbs-operator-app-ollama-1']
FILES = ['src/special-stock-request-repository.js', 'src/special-stock-request-service.js']

def capture():
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(n) for n in r.DEPENDENCIES]
    target = r.RELEASE / 'before'
    target.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(target, filter='data')
    for p in target.rglob('*'):
        p.chmod(p.stat().st_mode | (0o055 if p.is_dir() else 0o044))
    assert r.metadata(r.APP) == before
    shutil.copytree(target, r.RELEASE / 'candidate')
    workspace = r.RELEASE / 'workspace-before'
    for name in FILES:
        p = workspace / name
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, p)
        # Worker has its own deployed baseline; apply only the task diff below.
    r.save('capture.json', {'app': before, 'dependencies': dependencies, 'beforeTree': r.files_at(target), 'capturedAt': r.now()})
    print(json.dumps({'captured': True, 'imageId': before['imageId']}))

def stage():
    data = json.loads((r.RELEASE / 'capture.json').read_text())
    import difflib
    patch = ''
    for name in FILES:
        old = (SERVER / 'deployments/special-po-warning-20261019/before' / name).read_text().splitlines(True)
        new = (SERVER / name).read_text().splitlines(True)
        patch += ''.join(difflib.unified_diff(old, new, fromfile='a/'+name, tofile='b/'+name))
    r.apply_patch(r.RELEASE / 'candidate', patch, 'worker')
    tree = r.files_at(r.RELEASE / 'candidate')
    changed = sorted(n for n in data['beforeTree'].keys() | tree.keys() if data['beforeTree'].get(n) != tree.get(n))
    assert changed == sorted(FILES), changed
    data.update(files=FILES, candidateTree=tree, candidateTreeHash=r.sha(json.dumps(tree, sort_keys=True).encode()),
                workspace={n: r.sha((SERVER / n).read_bytes()) for n in FILES},
                packages={n: r.sha((r.RELEASE / 'candidate' / n).read_bytes()) for n in ['package.json', 'package-lock.json']})
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'staged': True, 'files': FILES, 'candidateTreeHash': data['candidateTreeHash']}))

def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [r.metadata(n) for n in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    r.save('deployment-result.json', {'deployed': True, 'at': r.now(), 'imageId': live['imageId'],
        'changedFiles': FILES, 'configurationPreserved': True, 'dependentContainersUnchanged': True})
    print(json.dumps({'deployed': True, 'imageId': live['imageId']}))

def apply():
    data = r.state()
    r.current(data)
    check = json.loads((r.RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    r.config_check(data)
    r.assert_no_active_operations(r.preflight())
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'webhook-worker']
    try:
        with (r.RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(r.compose(data, 'release') + args, cwd=r.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (r.RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(r.compose(data, 'rollback') + args, cwd=r.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        raise

def config_check(data):
    for mode, tag in [('release', r.IMAGE), ('rollback', r.ROLLBACK)]:
        (r.RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  webhook-worker:\n    image: ' + tag + '\n    pull_policy: never\n')
    service = json.loads(subprocess.check_output(r.compose(data, 'release') + ['config', '--format', 'json'], cwd=r.ROOT))['services']['webhook-worker']
    live = json.loads(r.docker('inspect', r.APP))[0]
    image = json.loads(r.docker('image', 'inspect', data['candidateImageId']))[0]['Config']
    env = dict(entry.split('=', 1) for entry in image.get('Env', []))
    env.update({k: str(v) for k, v in service.get('environment', {}).items()})
    assert env == dict(entry.split('=', 1) for entry in live['Config']['Env']), 'Worker environment would change'
    for field, key in [('Cmd','command'),('Entrypoint','entrypoint'),('User','user'),('WorkingDir','working_dir')]:
        expected = image.get(field) if service.get(key) is None else service[key]
        assert expected == live['Config'].get(field), 'Worker runtime setting would change: ' + field
    r.save('config-check.json', {'environmentPreserved': True, 'commandPreserved': True, 'imageOnlyOverride': True})

def ready_worker(image_id):
    import time
    for _ in range(20):
        row = json.loads(r.docker('inspect', r.APP))[0]
        if row['Image'] == image_id and row['State']['Running'] and row['RestartCount'] == 0:
            time.sleep(2)
            again = json.loads(r.docker('inspect', r.APP))[0]
            if again['State']['Running'] and again['RestartCount'] == 0:
                return
        time.sleep(0.5)
    raise RuntimeError('Worker did not remain running')

r.config_check = config_check
r.ready = ready_worker

if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'build': r.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
