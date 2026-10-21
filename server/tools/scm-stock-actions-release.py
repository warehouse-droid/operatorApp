"""Ship SCM line actions and persistent Smart font controls."""
import importlib.util
import difflib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
ARTIFACT = SERVER / 'test-artifacts/scm-stock-actions-20261006'
RELEASE = SERVER / 'deployments/scm-stock-actions-20261006'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:scm-stock-actions-20261006'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-scm-stock-actions-baseline-reader'
release.CHECK_NAME = 'mbbs-scm-stock-actions-image-check'


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = release.metadata(release.APP)
    assert before['imageId']=='sha256:32bed0829284d7d5c76c993132ba77037cb59ba20b9f7164c14c463bb74db8d8', 'Expected reviewed live baseline'
    dependencies = [release.metadata(n) for n in release.DEPENDENCIES]
    baseline = RELEASE / 'before'
    baseline.mkdir()
    archive = release.docker('exec', release.APP, 'tar', '-cf', '-', '-C', '/app',
        'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert release.metadata(release.APP) == before
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    original = json.loads((ARTIFACT / 'workspace-before.json').read_text())
    patch = ''
    for name, digest in original.items():
        old = ARTIFACT / 'workspace-before' / name
        assert release.sha(old.read_bytes()) == digest
        patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True),
            (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name, n=3))
    release.apply_patch(candidate, patch, 'scm-stock-actions')
    additions=['src/regular-stock-waitlist-transition.js','public/regular-stock-waitlist-transition.js']
    for name in additions:
        assert not (candidate/name).exists()
        shutil.copy2(SERVER/name,candidate/name)
    before_tree, after_tree = release.files_at(baseline), release.files_at(candidate)
    changed = sorted(n for n in before_tree.keys() | after_tree.keys() if before_tree.get(n) != after_tree.get(n))
    expected=[name for name,digest in original.items() if release.sha((SERVER/name).read_bytes())!=digest]
    assert changed == sorted([*expected, *additions]), 'Unexpected release scope'
    release.save('manifest.json', {'capturedAt':release.now(), 'app':before, 'dependencies':dependencies,
        'files':changed, 'beforeTree':before_tree, 'candidateTree':after_tree,
        'candidateTreeHash':release.sha(json.dumps(after_tree,sort_keys=True).encode()),
        'workspace':{n:release.sha((SERVER/n).read_bytes()) for n in changed},
        'packages':{n:release.sha((candidate/n).read_bytes()) for n in ['package.json','package-lock.json']}})
    print(json.dumps({'captured':True,'changedFiles':len(changed),'runtimeFiles':len(after_tree)}),flush=True)


def http_check(data):
    paths = {'public/sales-stock-requests.html':'/sales/stock-requests', 'public/scm-stock-requests.html':'/scm/stock-requests', 'public/scm-smart.html':'/scm/smart'}
    files = {n:data['candidateTree'][n] for n in data['files'] if n.startswith('public/') and n in data['candidateTree']}
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const files=FILES,paths=PATHS,result={};
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
let response=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
for(const [file,hash] of Object.entries(files)){
const url=paths[file]||'/'+file.slice(7);
response=await fetch(base+url+'?release=scm-stock-actions-20261006',{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,url);
let body=Buffer.from(await response.arrayBuffer());
if(file.endsWith('.html'))body=Buffer.from(body.toString().replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,''));
assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,url);}
response=await fetch(base+'/api/navigation/menu-order',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);assert.ok((await response.json()).revision>=1);
for(const audience of ['sales','scm']){response=await fetch(base+'/api/'+audience+'/stock-requests/1/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});assert.equal(response.status,401,'reply requires login');}
response=await fetch(base+'/api/scm/waitlist/stocking-requests/1/lines/1',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});assert.equal(response.status,401,'conversion requires login');
response=await fetch(base+'/api/scm/waitlist/customers?search=test',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,401,'customer lookup requires login');
result[base]={health:200,assets:Object.keys(files).length,menuOrder:200,replyAuthGuards:401,waitlistAuthGuards:401};}
console.log(JSON.stringify(result));""".replace('FILES',json.dumps(files)).replace('PATHS',json.dumps(paths))
    return json.loads(release.docker('exec','-i',release.APP,'node','--input-type=module',input=script.encode(),timeout=100))


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    live = release.metadata(release.APP)
    assert live['imageId'] == data['candidateImageId'] and live['configuration'] == data['app']['configuration']
    assert [release.metadata(n) for n in release.DEPENDENCIES] == data['dependencies']
    assert json.loads(release.docker('exec',release.APP,'node','-e',release.HASH_SCRIPT)) == data['candidateTree']
    checked = http_check(data)
    result = {'deployed':True,'at':release.now(),'image':release.IMAGE,'imageId':live['imageId'],
        'candidateTreeHash':data['candidateTreeHash'],'changedFiles':data['files'],
        'runtimeFilesVerified':len(data['candidateTree']),'configurationPreserved':True,
        'workerAndDependenciesUnchanged':True,'schemaChanges':False,'http':checked}
    release.save('deployment-result.json',result)
    print(json.dumps({'deployed':True,'http':checked}),flush=True)


def apply():
    data = release.state()
    release.current(data)
    check = json.loads((RELEASE/'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert release.docker('image','inspect','--format','{{.Id}}',release.IMAGE).decode().strip() == data['candidateImageId']
    release.config_check(data)
    release.assert_no_active_operations(release.preflight())
    leases = release.edit_lease_identities()
    samples, stop = [], threading.Event()
    start = time.monotonic()
    def probe():
        while not stop.is_set():
            instant = time.monotonic()
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/health',timeout=0.5) as response:
                    ok = response.status == 200
            except OSError:
                ok = False
            samples.append({'seconds':round(instant-start,3),'ok':ok})
            stop.wait(0.2)
    thread = threading.Thread(target=probe,daemon=True)
    thread.start()
    args = ['up','-d','--no-build','--no-deps','--pull','never','app']
    try:
        with (RELEASE/'cutover.log').open('wb') as output:
            subprocess.run(release.compose(data,'release')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
        after = release.edit_lease_identities()
        release.save('editing-lease-result.json',{'before':leases,'after':after,'retained':set(leases)<=set(after)})
    except BaseException:
        with (RELEASE/'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data,'rollback')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        release.ready(data['app']['imageId'])
        release.save('rollback-result.json',{'restoredImageId':data['app']['imageId']})
        raise
    finally:
        stop.set();thread.join(timeout=2)
        failed = [row['seconds'] for row in samples if not row['ok']]
        recovered = [row['seconds'] for row in samples if row['ok'] and failed and row['seconds']>max(failed)]
        release.save('cutover.json',{'seconds':round(time.monotonic()-start,3),
            'observedInterruptionSeconds':round(min(recovered)-min(failed),3) if recovered else None if failed else 0,'samples':samples})


def refresh():
    data=release.state()
    assert release.metadata(release.APP)==data['app']
    assert [release.metadata(n) for n in release.DEPENDENCIES]==data['dependencies']
    assert json.loads(release.docker('exec',release.APP,'node','-e',release.HASH_SCRIPT))==data['beforeTree']
    original=json.loads((ARTIFACT/'workspace-before.json').read_text())
    candidate=RELEASE/'candidate-next'
    shutil.copytree(RELEASE/'before',candidate)
    patch=''
    for name,digest in original.items():
        old=ARTIFACT/'workspace-before'/name
        assert release.sha(old.read_bytes())==digest
        patch+=''.join(difflib.unified_diff(old.read_text().splitlines(True),(SERVER/name).read_text().splitlines(True),fromfile='a/'+name,tofile='b/'+name,n=3))
    release.apply_patch(candidate,patch,'scm-stock-actions-final')
    additions=['src/regular-stock-waitlist-transition.js','public/regular-stock-waitlist-transition.js']
    for name in additions:
        assert not (candidate/name).exists()
        shutil.copy2(SERVER/name,candidate/name)
    tree=release.files_at(candidate)
    changed=sorted(n for n in data['beforeTree'].keys()|tree.keys() if data['beforeTree'].get(n)!=tree.get(n))
    expected=[name for name,digest in original.items() if release.sha((SERVER/name).read_bytes())!=digest]
    assert changed==sorted([*expected,*additions]), 'Unexpected release scope'
    version=time.time_ns()
    release.save(f'manifest-before-refresh-{version}.json',data)
    (RELEASE/'candidate').rename(RELEASE/f'candidate-before-refresh-{version}')
    candidate.rename(RELEASE/'candidate')
    data.update(files=changed,candidateTree=tree,candidateTreeHash=release.sha(json.dumps(tree,sort_keys=True).encode()),workspace={n:release.sha((SERVER/n).read_bytes()) for n in changed})
    release.save('manifest.json',data)
    print(json.dumps({'refreshed':True,'files':len(changed),'candidateTreeHash':data['candidateTreeHash']}),flush=True)


if __name__ == '__main__':
    {'capture':capture,'refresh':refresh,'build':release.build,'apply':apply,'verify':verify}[sys.argv[1]]()
