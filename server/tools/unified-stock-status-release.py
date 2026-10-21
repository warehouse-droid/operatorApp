"""Deploy the verified Regular Stock status delta over the current live image."""
import atexit
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/unified-stock-status'
spec = importlib.util.spec_from_file_location('release_cutover', SERVER / 'tools/dispatch-freshness-release.py')
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)
r = cutover.r
r.RELEASE = SERVER / 'deployments/unified-stock-status-20261020'
r.IMAGE = 'mbbs-operator-app:unified-stock-status-20261020'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-unified-stock-status-release-reader'
r.CHECK_NAME = 'mbbs-unified-stock-status-release-check'


def prepare():
    static = json.loads((ARTIFACT / 'static.json').read_text())
    assert all(r.sha((SERVER / name).read_bytes()) == digest for name, digest in static['hashes'].items()), 'Tested source changed'
    results = json.loads((ARTIFACT / 'results-full.json').read_text())
    assert all(row['exit'] == 0 or row['baselineOnly'] for row in results)
    assert next(row for row in results if row['name'] == 'regular-stock-status')['passed'] == 8
    coverage = json.loads((ARTIFACT / 'changed-line-coverage.json').read_text())
    assert all(not row.get('missingCoverage') and not row['uncovered'] for row in coverage)
    files = json.loads((SERVER / 'tools/unified-stock-status-files.json').read_text())
    original = json.loads((ARTIFACT / 'before/manifest.json').read_text())
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(name) for name in r.DEPENDENCIES]
    baseline = r.RELEASE / 'before'
    baseline.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
                       'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert r.metadata(r.APP) == before, 'Live application changed during capture'
    for path in baseline.rglob('*'):
        path.chmod(path.stat().st_mode | (0o055 if path.is_dir() else 0o044))
    candidate = r.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    expected = []
    for name in files:
        if name in original:
            old = ARTIFACT / 'before' / name
            assert r.sha(old.read_bytes()) == original[name], 'Task baseline changed: ' + name
            if old.read_bytes() == (SERVER / name).read_bytes():
                continue
            patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True),
                (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name, n=3))
        else:
            assert not (candidate / name).exists(), 'New module already exists in production: ' + name
            shutil.copy2(SERVER / name, candidate / name)
        expected.append(name)
    r.apply_patch(candidate, patch, 'unified-status')
    before_tree, tree = r.files_at(baseline), r.files_at(candidate)
    changed = sorted(name for name in before_tree.keys() | tree.keys() if before_tree.get(name) != tree.get(name))
    assert changed == sorted(expected), 'Unexpected release scope: ' + repr(changed)
    data = {'capturedAt': r.now(), 'app': before, 'dependencies': dependencies,
            'files': changed, 'beforeTree': before_tree, 'candidateTree': tree,
            'candidateTreeHash': r.sha(json.dumps(tree, sort_keys=True).encode()),
            'workspace': {name: static['hashes'][name] for name in changed},
            'packages': {name: r.sha((candidate / name).read_bytes()) for name in ['package.json', 'package-lock.json']}}
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'prepared': True, 'changedFiles': changed,
        'candidateFilesDifferentFromWorkspace': [name for name in changed if tree[name] != static['hashes'][name]],
        'candidateTreeHash': data['candidateTreeHash']}), flush=True)


def validated():
    data = r.state()
    r.current(data)
    result_dir = r.RELEASE / 'validation-artifacts/unified-stock-status'
    results = json.loads((result_dir / 'results-full.json').read_text())
    assert results[-1]['name'] == 'changed-coverage', 'Validation did not finish'
    assert all(row['exit'] == 0 or row['baselineOnly'] for row in results)
    previous = json.loads((ARTIFACT / 'results-full.json').read_text())
    assert [(row['name'], row['tests'], row['failed']) for row in results] == [
        (row['name'], row['tests'], row['failed']) for row in previous], 'Release regression results changed'
    static = json.loads((result_dir / 'static.json').read_text())
    assert all(static['hashes'][name] == data['candidateTree'][name] for name in data['files'])
    coverage = json.loads((result_dir / 'changed-line-coverage.json').read_text())
    assert all(not row.get('missingCoverage') and not row['uncovered'] for row in coverage)
    assert (r.RELEASE / 'validation-cleanup.json').exists(), 'Cleanup was not recorded'
    cleanup = json.loads((r.RELEASE / 'validation-cleanup.json').read_text())
    assert cleanup['passed']
    r.save('validation-passed.json', {'passed': True, 'at': r.now(),
        'candidateTreeHash': data['candidateTreeHash'], 'results': results,
        'addedLinesCovered': sum(row['covered'] for row in coverage),
        'cleanupVerified': True, 'originalEvidence': str(ARTIFACT / 'results-full.json')})
    print(json.dumps({'validated': True, 'exactCandidateTree': data['candidateTreeHash']}), flush=True)


def http_check(data):
    paths = {'public/sales-stock-requests.html': '/sales/stock-requests',
             'public/scm-stock-requests.html': '/scm/stock-requests'}
    assets = {name: data['candidateTree'][name] for name in data['files'] if name.startswith('public/')}
    urls = {name: [route] for name, route in paths.items()}
    sources = ['public/sales-stock-requests.html', 'public/scm-stock-requests.html',
               'public/sales-stock-requests.js', 'public/scm-stock-requests.js',
               'public/regular-stock-status-ui.js']
    for name in assets:
        if name in urls:
            continue
        pattern = re.escape('/' + name.removeprefix('public/')) + r'\?[^\s\"\'<>)]+'
        matches = set()
        for source in sources:
            matches.update(re.findall(pattern, (r.RELEASE / 'candidate' / source).read_text()))
        assert matches, 'Missing versioned URL for ' + name
        urls[name] = sorted(matches)
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const assets=ASSETS,urls=URLS,results={};
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
 assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 let checked=0;
 for(const [name,hash] of Object.entries(assets))for(const path of urls[name]){
  const response=await fetch(base+path,{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,path);let body=Buffer.from(await response.arrayBuffer());
  if(name.endsWith('.html'))body=Buffer.from(body.toString().replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,''));
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,path);checked++;
 }
 for(const path of ['/api/sales/stock-requests?unifiedStatus=active','/api/scm/stock-requests?unifiedStatus=active','/api/scm/waitlist/requests?unifiedStatus=closed']){
  const response=await fetch(base+path,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,401,path);
 }
 results[base]={health:200,versionedAssetsVerified:checked,anonymousApisDenied:3};
}console.log(JSON.stringify(results));
""".replace('ASSETS', json.dumps(assets)).replace('URLS', json.dumps(urls))
    return json.loads(r.docker('exec', '-i', r.APP, 'node', '--input-type=module', input=script.encode(), timeout=120))


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration'], 'Application configuration changed'
    assert [r.metadata(name) for name in r.DEPENDENCIES] == data['dependencies'], 'Dependent service changed'
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    checked = http_check(data)
    r.save('deployment-result.json', {'deployed': True, 'at': r.now(), 'image': r.IMAGE,
        'imageId': live['imageId'], 'candidateTreeHash': data['candidateTreeHash'],
        'runtimeFilesVerified': len(data['candidateTree']), 'changedFiles': data['files'],
        'configurationPreserved': True, 'dependentServicesPreserved': True,
        'noSchemaOrDataChanges': True, 'http': checked})
    print(json.dumps({'deployed': True, 'image': r.IMAGE, 'http': checked}), flush=True)


cutover.verify = verify

if __name__ == '__main__':
    os.umask(0o022)
    if sys.argv[1] in ['build', 'apply', 'verify']:
        atexit.register(r.cleanup_manual)
    {'prepare': prepare, 'validated': validated, 'build': r.build,
     'apply': cutover.apply, 'verify': verify}[sys.argv[1]]()
