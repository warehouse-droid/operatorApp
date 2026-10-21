"""Release the tested Dispatch freshness patch on the current production image."""
import atexit
import difflib
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/dispatch-freshness-20261019'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
r.RELEASE = SERVER / 'deployments/dispatch-freshness-20261019'
r.IMAGE = 'mbbs-operator-app:dispatch-freshness-20261019'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-dispatch-freshness-release-reader'
r.CHECK_NAME = 'mbbs-dispatch-freshness-release-check'
SCRIPT_URL = '/dispatch.js?v=20261019-dispatch-freshness-v1'


def capture():
    evidence = json.loads((ARTIFACT / 'backend-frontend-evidence.json').read_text())
    approved = evidence['runtimeHashes']
    assert evidence['status'] == 'passed' and evidence['checksPassed'] == 51
    assert all(r.sha((SERVER / n).read_bytes()) == digest for n, digest in approved.items()), 'Tested source changed'
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(n) for n in r.DEPENDENCIES]
    target = r.RELEASE / 'before'
    target.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
                       'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(target, filter='data')
    assert r.metadata(r.APP) == before, 'Production changed during capture'
    for p in target.rglob('*'):
        p.chmod(p.stat().st_mode | (0o055 if p.is_dir() else 0o044))
    candidate = r.RELEASE / 'candidate'
    shutil.copytree(target, candidate)
    r.save('capture.json', {'app': before, 'dependencies': dependencies, 'capturedAt': r.now(),
                          'beforeTree': r.files_at(target), 'workspace': approved})
    patch = ''.join(''.join(difflib.unified_diff(
        (ARTIFACT / 'before' / name).read_text().splitlines(True),
        (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name, n=3))
        for name in approved)
    r.apply_patch(candidate, patch, 'dispatch-freshness')
    data = json.loads((r.RELEASE / 'capture.json').read_text())
    tree = r.files_at(candidate)
    changed = sorted(n for n in data['beforeTree'].keys() | tree.keys()
                     if data['beforeTree'].get(n) != tree.get(n))
    assert changed == sorted(approved), 'Unexpected release scope: ' + repr(changed)
    data.update(files=changed, candidateTree=tree,
                candidateTreeHash=r.sha(json.dumps(tree, sort_keys=True).encode()),
                packages={n: r.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']})
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'captured': True, 'files': changed, 'candidateTreeHash': data['candidateTreeHash'],
                      'candidateMatchesTestedFiles': {n: tree[n] == digest for n, digest in approved.items()}}), flush=True)


def version_asset():
    data = r.state()
    r.current(data)
    path = 'public/dispatch.html'
    assert (SERVER / path).read_bytes() == (r.RELEASE / 'before' / path).read_bytes()
    target = r.RELEASE / 'candidate' / path
    old = target.read_text()
    new, count = re.subn(r'(?<=src=")/dispatch\.js\?v=[^" ]+', SCRIPT_URL, old)
    assert count == 1 and new != old
    target.write_text(new)
    (SERVER / path).write_text(new)
    data['files'] = sorted([*data['files'], path])
    data['workspace'][path] = r.sha(new.encode())
    data['candidateTree'] = r.files_at(r.RELEASE / 'candidate')
    data['candidateTreeHash'] = r.sha(json.dumps(data['candidateTree'], sort_keys=True).encode())
    data['dispatchScriptUrl'] = SCRIPT_URL
    r.save('manifest.json', data)
    r.save('asset-version.json', {'at': r.now(), 'scriptUrl': SCRIPT_URL,
        'reason': 'The public CDN serves JavaScript with max-age=14400; the HTML remains max-age=0.'})
    print(json.dumps({'versioned': True, 'scriptUrl': SCRIPT_URL}), flush=True)


def validation():
    data = r.state()
    r.current(data)
    result = json.loads((r.RELEASE / 'validation/results/release.json').read_text())
    prior = json.loads((ARTIFACT / 'results/final.json').read_text())
    assert len(result['results']) == len(prior['results']) == 26
    for row in result['results']:
        old = next(item for item in prior['results'] if item['file'] == row['file'])
        assert row['exit'] == old['exit'] and row['failures'] == old['failures'], row
    normalize = lambda message: json.dumps({**message,
        'message': re.sub(r'on line \d+ column \d+', 'at existing declaration', message['message'])}, sort_keys=True)
    previous_lint = {normalize(row) for row in prior['diagnostics']}
    assert all(normalize(row) in previous_lint for row in result['diagnostics']), 'New lint diagnostics'
    replay = json.loads((r.RELEASE / 'validation/results/full-day-replay/latest.json').read_text())
    assert replay['status'] == 'passed' and len(replay['consistencyChecks']) >= 51
    assert all(row['status'] == 'passed' for row in replay['consistencyChecks'])
    assert not replay['refreshAudit']['manualRefreshClicks']
    assert all(digest == data['candidateTree'][n] for n, digest in replay['runtimeHashes'].items())
    r.save('validation-passed.json', {'passed': True, 'at': r.now(),
        'candidateTreeHash': data['candidateTreeHash'], 'suites': len(result['results']),
        'tests': sum(row['tests'] for row in result['results']),
        'pass': sum(row['pass'] for row in result['results']),
        'unchangedFailures': [row for row in result['results'] if row['exit']],
        'replayActions': len(replay['actions']), 'consistencyChecks': len(replay['consistencyChecks']),
        'replayArtifact': replay['artifact'],
        'slowActions': [row for row in replay['actions'] if row['slow']],
        'priorGauntlet': str(ARTIFACT / 'evidence.json'),
        'noMigrationOrDependencyChanges': True})
    print(json.dumps({'validated': True, 'suites': len(result['results']),
                      'consistencyChecks': len(replay['consistencyChecks'])}), flush=True)


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration'], 'Runtime configuration changed'
    assert [r.metadata(n) for n in r.DEPENDENCIES] == data['dependencies'], 'Dependent containers changed'
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    checks = r.http_check({},
                         ['/api/dispatch/v2/order-feed', '/api/dispatch/plans', '/api/dispatch/config'])
    script = """import assert from 'node:assert/strict';import crypto from 'node:crypto';
const expected=EXPECTED,scriptUrl=SCRIPT_URL,results=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const page=await fetch(base+'/dispatch/planning',{signal:AbortSignal.timeout(15000)});
 assert.equal(page.status,200);assert.ok((await page.text()).includes('src="'+scriptUrl+'"'));
 const asset=await fetch(base+scriptUrl,{signal:AbortSignal.timeout(15000)});
 assert.equal(asset.status,200);
 assert.equal(crypto.createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),expected);
 results.push({base,pageStatus:200,versionedAssetVerified:true,scriptUrl});
}console.log(JSON.stringify(results));""".replace('EXPECTED', json.dumps(data['candidateTree']['public/dispatch.js'])).replace('SCRIPT_URL', json.dumps(SCRIPT_URL))
    browser_assets = json.loads(r.docker('exec', '-i', r.APP, 'node', '--input-type=module', input=script.encode(), timeout=60))
    r.save('deployment-result.json', {'deployed': True, 'at': r.now(), 'image': r.IMAGE,
        'imageId': live['imageId'], 'candidateTreeHash': data['candidateTreeHash'],
        'changedFiles': data['files'], 'runtimeFilesVerified': len(data['candidateTree']),
        'configurationPreserved': True, 'dependentContainersUnchanged': True,
        'noMigrationOrDataRepair': True, 'http': checks, 'browserAssets': browser_assets})
    print(json.dumps({'deployed': True, 'image': r.IMAGE, 'http': checks}), flush=True)


def apply():
    data = r.state()
    r.current(data)
    check = json.loads((r.RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    r.config_check(data)
    r.assert_no_active_operations(r.preflight())
    r.current(data)
    leases = r.edit_lease_identities()
    samples, stop = [], threading.Event()
    start = time.monotonic()

    def probe():
        while not stop.is_set():
            stamp = time.monotonic()
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=0.5) as response:
                    ok = response.status == 200
            except OSError:
                ok = False
            samples.append({'seconds': round(stamp - start, 3), 'ok': ok})
            stop.wait(0.2)

    watcher = threading.Thread(target=probe, daemon=True)
    watcher.start()
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (r.RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(r.compose(data, 'release') + args, cwd=r.ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
        after = r.edit_lease_identities()
        r.save('editing-lease-result.json', {'before': leases, 'after': after,
               'retained': set(leases) <= set(after), 'leasesModifiedByDeployment': False})
    except BaseException:
        with (r.RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(r.compose(data, 'rollback') + args, cwd=r.ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        r.save('rollback-result.json', {'restoredImageId': data['app']['imageId'], 'at': r.now()})
        raise
    finally:
        stop.set()
        watcher.join(timeout=2)
        failed = [row['seconds'] for row in samples if not row['ok']]
        recovered = [row['seconds'] for row in samples if row['ok'] and failed and row['seconds'] > max(failed)]
        r.save('cutover.json', {'seconds': round(time.monotonic() - start, 3),
            'observedInterruptionSeconds': round(min(recovered) - min(failed), 3) if recovered else 0 if not failed else None,
            'samples': samples})


if __name__ == '__main__':
    if sys.argv[1] in ['build', 'apply', 'verify']:
        atexit.register(r.cleanup_manual)
    {'capture': capture, 'version-asset': version_asset, 'validation': validation,
     'build': r.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
