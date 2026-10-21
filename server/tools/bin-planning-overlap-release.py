"""Release the saved Dispatch timing fix over the current application image."""
import atexit
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/bin-planning-overlap-20261020'
spec = importlib.util.spec_from_file_location('freshness_release', SERVER / 'tools/dispatch-freshness-release.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
r = f.r
r.RELEASE = SERVER / 'deployments/bin-planning-overlap-20261020'
r.IMAGE = 'mbbs-operator-app:bin-planning-overlap-20261020'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-bin-overlap-release-reader'
r.CHECK_NAME = 'mbbs-bin-overlap-release-check'
FILES = ['public/dispatch.html', 'public/dispatch.js', 'public/mbt-planning.html']
SCRIPT_URL = '/dispatch.js?v=20261020-bin-saved-timing-v1'


def prepare():
    evidence = json.loads((ARTIFACT / 'result.json').read_text())
    assert evidence['green']['total'] == 23 and evidence['green']['failed'] == 0
    for name, digest in evidence['files_sha256'].items():
        assert r.sha((r.ROOT / name).read_bytes()) == digest, 'Tested source changed: ' + name
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(n) for n in r.DEPENDENCIES]
    target = r.RELEASE / 'before'
    target.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
                       'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(target, filter='data')
    for path in target.rglob('*'):
        path.chmod(path.stat().st_mode | (0o055 if path.is_dir() else 0o044))
    assert r.metadata(r.APP) == before, 'Production changed during capture'
    candidate = r.RELEASE / 'candidate'
    shutil.copytree(target, candidate)
    for name in FILES:
        assert (target / name).read_bytes() == (ARTIFACT / 'baseline' / Path(name).name).read_bytes(), 'Live planner changed: ' + name
        shutil.copy2(SERVER / name, candidate / name)
    before_tree, tree = r.files_at(target), r.files_at(candidate)
    assert sorted(n for n in tree if tree[n] != before_tree.get(n)) == FILES
    data = {'app': before, 'dependencies': dependencies, 'beforeTree': before_tree,
            'candidateTree': tree, 'files': FILES, 'capturedAt': r.now(),
            'candidateTreeHash': r.sha(json.dumps(tree, sort_keys=True).encode()),
            'workspace': {n: r.sha((SERVER / n).read_bytes()) for n in FILES},
            'packages': {n: r.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']}}
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'prepared': True, 'changedFiles': FILES, 'runtimeFiles': len(tree),
                      'baseImageId': before['imageId']}), flush=True)


def validation():
    data = r.state()
    r.current(data)
    out = r.RELEASE / 'validation'
    unit = (out / 'unit.log').read_text()
    browser = (out / 'browser.log').read_text()
    assert '# tests 6\n' in unit and '# fail 0\n' in unit
    assert 'Isolated bin-planning-selected run passed: 4 file(s), 17 test(s).' in browser
    for name in ['docker-ps.log', 'docker-ps-a.log']:
        names = {line.split()[0] for line in (out / name).read_text().splitlines()}
        assert names == {r.APP, *r.DEPENDENCIES}, 'Unexpected containers remain'
    assert json.loads((out / 'health.json').read_text())['ok']
    r.save('validation-passed.json', {'passed': True, 'at': r.now(),
        'candidateTreeHash': data['candidateTreeHash'], 'tests': 23,
        'failures': 0, 'cleanupVerified': True, 'evidence': str(out)})
    print(json.dumps({'validated': True, 'tests': 23, 'cleanupVerified': True}), flush=True)


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration'], 'Runtime configuration changed'
    assert [r.metadata(n) for n in r.DEPENDENCIES] == data['dependencies'], 'Dependent containers changed'
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    script = """import assert from 'node:assert/strict';import crypto from 'node:crypto';
const expected=EXPECTED,scriptUrl=SCRIPT_URL,results=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
 assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const path of ['/dispatch/planning','/mbt/planning']){
  const page=await fetch(base+path,{signal:AbortSignal.timeout(15000)});
  assert.equal(page.status,200);assert.ok((await page.text()).includes('src="'+scriptUrl+'"'),path);
 }
 const asset=await fetch(base+scriptUrl,{signal:AbortSignal.timeout(15000)});
 assert.equal(asset.status,200);
 assert.equal(crypto.createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),expected);
 for(const path of ['/api/dispatch/plans','/api/mbt/planning?planDate=2026-10-20']){
  assert.equal((await fetch(base+path,{signal:AbortSignal.timeout(15000)})).status,401,path);
 }
 results.push({base,health:200,planningPages:2,versionedAssetVerified:true,anonymousApisDenied:2});
}console.log(JSON.stringify(results));""".replace('EXPECTED', json.dumps(data['candidateTree']['public/dispatch.js'])).replace('SCRIPT_URL', json.dumps(SCRIPT_URL))
    http = json.loads(r.docker('exec', '-i', r.APP, 'node', '--input-type=module', input=script.encode(), timeout=100))
    r.save('deployment-result.json', {'deployed': True, 'at': r.now(), 'image': r.IMAGE,
        'imageId': live['imageId'], 'changedFiles': FILES, 'runtimeFilesVerified': len(data['candidateTree']),
        'configurationPreserved': True, 'dependentContainersUnchanged': True,
        'noMigrationOrDataRepair': True, 'http': http})
    print(json.dumps({'deployed': True, 'image': r.IMAGE, 'http': http}), flush=True)


f.verify = verify

if __name__ == '__main__':
    if sys.argv[1] in ['build', 'apply', 'verify']:
        atexit.register(r.cleanup_manual)
    {'prepare': prepare, 'validation': validation, 'build': r.build, 'apply': f.apply, 'verify': verify}[sys.argv[1]]()
