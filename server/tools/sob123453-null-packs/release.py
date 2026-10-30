"""Ship only the existing SO transport normalization over the current live image."""
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
r.RELEASE = SERVER / 'deployments/sob123453-null-packs-20261026'
r.IMAGE = 'mbbs-operator-app:sob123453-null-packs-20261026'
r.ROLLBACK = r.IMAGE + '-rollback'
FILES = ['src/netsuite.js', 'public/order-pack-quantities.js']


def capture():
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    before = r.metadata(r.APP)
    target = r.RELEASE / 'before'
    target.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(target, filter='data')
    assert r.metadata(r.APP) == before
    for p in target.rglob('*'):
        p.chmod(p.stat().st_mode | (0o055 if p.is_dir() else 0o044))
    shutil.copytree(target, r.RELEASE / 'candidate')
    r.save('capture.json', {'app': before, 'dependencies': [r.metadata(n) for n in r.DEPENDENCIES],
                           'beforeTree': r.files_at(target), 'capturedAt': r.now()})
    print(json.dumps({'captured': True, 'imageId': before['imageId']}))


def function(source, name):
    start = source.index('export async function ' + name + '(')
    end = source.index('\n}', start) + 2
    return source[start:end]


def stage():
    data = json.loads((r.RELEASE / 'capture.json').read_text())
    candidate = r.RELEASE / 'candidate'
    live = (candidate / FILES[0]).read_text()
    workspace = (SERVER / FILES[0]).read_text()
    assert 'normalizeSalesOrderPackPayload' not in live
    for name in ['createSalesOrderInNetSuite', 'transformEstimateToSalesOrderInNetSuite', 'createSpecialDiscountSalesOrderInNetSuite']:
        live = live.replace(function(live, name), function(workspace, name), 1)
    live = "import { normalizeSalesOrderPackPayload } from '../public/order-pack-quantities.js';\n" + live
    (candidate / FILES[0]).write_text(live)
    shutil.copy2(SERVER / FILES[1], candidate / FILES[1])
    tree = r.files_at(candidate)
    changed = sorted(n for n in data['beforeTree'].keys() | tree.keys() if data['beforeTree'].get(n) != tree.get(n))
    assert changed == sorted(FILES), changed
    patch = ''
    for name in FILES:
        old = r.RELEASE / 'before' / name
        patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],
            (candidate / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (r.RELEASE / 'app.patch').write_text(patch)
    data.update(files=FILES, candidateTree=tree, candidateTreeHash=r.sha(json.dumps(tree, sort_keys=True).encode()),
        workspace={n: r.sha((SERVER / n).read_bytes()) for n in FILES},
        packages={n: r.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']})
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'staged': True, 'files': FILES, 'candidateTreeHash': data['candidateTreeHash']}))


def build():
    data = r.state()
    r.current(data)
    check = json.loads((r.RELEASE / 'validation-passed.json').read_text())
    assert check['passed'] and check['candidateTreeHash'] == data['candidateTreeHash']
    r.docker('tag', data['app']['imageId'], r.ROLLBACK)
    stage_dir = r.RELEASE / 'stage'
    for name in FILES:
        target = stage_dir / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(r.RELEASE / 'candidate' / name, target)
    (stage_dir / 'Dockerfile').write_text('FROM ' + r.ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', r.IMAGE), ('rollback', r.ROLLBACK)]:
        (r.RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', r.IMAGE, str(stage_dir)], check=True, timeout=180)
    data['candidateImageId'] = r.docker('image', 'inspect', '--format', '{{.Id}}', r.IMAGE).decode().strip()
    r.save('manifest.json', data)
    r.config_check(data)
    print(json.dumps({'built': True, 'imageId': data['candidateImageId']}))


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [r.metadata(n) for n in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    result = {'deployed': True, 'at': r.now(), 'imageId': live['imageId'], 'files': FILES,
              'configurationPreserved': True, 'dependenciesUnchanged': True, 'runtimeFilesVerified': len(data['candidateTree'])}
    r.save('deployment-result.json', result)
    print(json.dumps(result))


def apply():
    data = r.state()
    r.current(data)
    check = json.loads((r.RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    r.config_check(data)
    r.assert_no_active_operations(r.preflight())
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        subprocess.run(r.compose(data, 'release') + args, cwd=r.ROOT, check=True, timeout=60)
        verify()
    except BaseException:
        subprocess.run(r.compose(data, 'rollback') + args, cwd=r.ROOT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'build': build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
