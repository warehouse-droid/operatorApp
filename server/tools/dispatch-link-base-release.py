"""Scoped linked PO pickup release; preserve live configuration and driver data."""
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
r.RELEASE = SERVER / 'deployments/dispatch-link-base-20261019'
r.IMAGE = 'mbbs-operator-app:dispatch-link-base-20261019'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-pickup-default-reader'
r.CHECK_NAME = 'mbbs-pickup-default-check'
FILES = ['src/dispatch-repository.js', 'src/order-dependency-repository.js', 'src/dispatch-po-route-projection.js', 'public/dispatch.js']

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
        assert p.read_bytes() == (target / name).read_bytes(), 'Workspace/live differ: ' + name
    r.save('capture.json', {'app': before, 'dependencies': dependencies, 'beforeTree': r.files_at(target), 'capturedAt': r.now()})
    print(json.dumps({'captured': True, 'imageId': before['imageId']}))

def stage():
    data = json.loads((r.RELEASE / 'capture.json').read_text())
    for name in FILES:
        shutil.copy2(SERVER / name, r.RELEASE / 'candidate' / name)
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
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (r.RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(r.compose(data, 'release') + args, cwd=r.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (r.RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(r.compose(data, 'rollback') + args, cwd=r.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        raise

if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'build': r.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
