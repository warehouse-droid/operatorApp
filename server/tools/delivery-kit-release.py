"""Release the scoped delivery kit patch over the exact currently running image."""
import difflib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('delivery_kit_release_core', SERVER / 'tools/driver-inactivation-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
release = core.release
release.RELEASE = SERVER / 'deployments/delivery-kit-20261029'
release.IMAGE = 'mbbs-operator-app:delivery-kit-20261029'
release.ROLLBACK = 'mbbs-operator-app:delivery-kit-rollback-20261029'
release.FILES = ['src/sales-order-auto-fulfillment-kits.js', 'src/sales-order-auto-fulfillment-netsuite-adapter.js',
                 'src/sales-order-auto-fulfillment-service.js', 'src/sales-order-auto-fulfillment-repository.js', 'src/netsuite.js']


def prepare(refresh=False):
    out = release.RELEASE
    if refresh:
        assert not (out / 'deployment-result.json').exists(), 'Cannot refresh a deployed release'
        if (out / 'manifest.json').exists():
            shutil.copy2(out / 'manifest.json', out / 'previous-candidate-manifest.json')
        shutil.rmtree(out / 'candidate', ignore_errors=True)
        (out / 'verified.json').unlink(missing_ok=True)
    assert not (out / 'candidate').exists(), 'Candidate already exists; use explicit refresh after changes'
    initial = json.loads((out / 'initial-files.json').read_text())
    info = {'app': release.core.metadata(release.APP),
            'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES],
            'authorization': 'User requested the kit line fix and retry of affected orders.'}
    before = out / 'live-before'
    roots = json.loads(release.docker('exec', release.APP, 'node', '-e',
        "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('fs').existsSync(p))))"))
    subprocess.run(['tar', '--no-same-owner', '-xf', '-', '-C', str(before)], check=True,
        input=release.docker('exec', release.APP, 'tar', '-C', '/app', '-cf', '-', *roots))
    for name, values in initial.items():
        assert release.digest(before / name) == values['live'], 'Live source changed: ' + name
    candidate = out / 'candidate'
    shutil.copytree(before, candidate)
    patches = []
    for name in release.FILES:
        old = (before / name).read_text() if (before / name).exists() else ''
        new = (SERVER / name).read_text()
        if name == 'src/netsuite.js':
            anchor = "  return { canFulfill: row.item_type === 'Kit'"
            replacement = "  return { ...(row.item_type === 'Kit' ? {kitParent:true} : {}), canFulfill: row.item_type === 'Kit'"
            assert old.count(anchor) == 1
            assert new == (out / 'workspace-before' / name).read_text().replace(anchor, replacement), 'Unrelated new reader edits'
            new = old.replace(anchor, replacement)
        elif name in initial:
            assert initial[name]['same'], 'Review pre-existing work before copying ' + name
        (candidate / name).write_text(new)
        patches.extend(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='live/' + name, tofile='candidate/' + name))
    (out / 'release.patch').write_text(''.join(patches))
    for directory in [before, candidate]:
        for path in [directory, *directory.rglob('*')]:
            path.chmod(0o755 if path.is_dir() else 0o644)
    old_tree, new_tree = core.tree(before), core.tree(candidate)
    changed = sorted(name for name in old_tree.keys() | new_tree.keys() if old_tree.get(name) != new_tree.get(name))
    assert changed == sorted(release.FILES), changed
    info.update(files={name: new_tree[name] for name in release.FILES}, beforeTree=old_tree, candidateTree=new_tree)
    release.save('manifest.json', info)
    core.current(info)
    print(json.dumps({'prepared': True, 'files': changed, 'baseImage': info['app']['imageId']}))


def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        subprocess.run(['python3', str(SERVER.parent / 'docker/retention/retention.py'), 'run', '--',
                        sys.executable, __file__, 'validate'], check=True)
        return
    info = release.state()
    core.current(info)
    log = Path(os.environ['MBBS_TEST_ARTIFACT_DIR']) / 'validation.log'
    environment = dict(os.environ, DISPATCH_SOURCE_RUNTIME=str(release.RELEASE / 'candidate'),
        DISPATCH_SOURCE_MIGRATIONS=str(release.RELEASE / 'candidate/migrations'), DISPATCH_SOURCE_SKIP_BUILD='1')
    with log.open('w') as output:
        result = subprocess.run(['bash', 'docker/run-dispatch-source-tests.sh', 'node', 'tools/delivery-kit-checks.mjs'],
            cwd=SERVER.parent, env=environment, stdout=output, stderr=subprocess.STDOUT)
    content = log.read_text()
    for line in content.splitlines():
        if line.startswith(('DELIVERY_KIT_', '{"stage"', 'mbbs-operator-app')):
            print(line, flush=True)
    if result.returncode:
        print(content[-16000:], flush=True)
    assert result.returncode == 0, 'Candidate checks failed'
    core.current(info)
    report = json.loads(next(line.split(' ', 1)[1] for line in content.splitlines() if line.startswith('DELIVERY_KIT_REPORT ')))
    release.save('verified.json', {'passed': True, 'files': info['files'], 'candidateTree': info['candidateTree'],
                                 'report': report, 'cleanupVerified': True})


def verify():
    info = core.checked()
    release.core.ready(info['imageId'])
    assert release.core.metadata(release.APP)['configuration'] == info['app']['configuration']
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info['dependencies']
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', core.HASH_SCRIPT)) == info['candidateTree']
    script = """import assert from 'node:assert/strict';const checks=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
assert.equal((await fetch(base+'/api/driver/me')).status,401);checks.push({base,health:200,anonymous:401});
}console.log(JSON.stringify(checks));"""
    http = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'image': release.IMAGE, 'imageId': info['imageId'], 'http': http,
              'runtimeFilesVerified': len(info['candidateTree']), 'configurationPreserved': True,
              'dependenciesUnchanged': True, 'schemaChanged': False, 'rollbackImage': release.ROLLBACK}
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


core.verify = verify


def image_check():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        subprocess.run(['python3', str(SERVER.parent / 'docker/retention/retention.py'), 'run', '--',
                        sys.executable, __file__, 'image-check'], check=True)
        return
    core.image_check()


def apply():
    active = release.docker('exec', release.DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
        '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting';").decode().strip()
    assert active == '0', 'Active delivery IF posting; retry cutover when idle'
    core.apply()


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'refresh': lambda: prepare(True), 'validate': validate, 'build': core.build, 'image-check': image_check,
     'apply': apply, 'verify': verify}[sys.argv[1]]()
