"""Release only shared menu ordering over the currently running app."""
import atexit
import datetime
import difflib
import importlib.util
import io
import json
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
ARTIFACT = SERVER / 'test-artifacts/menu-order-20261006'
RELEASE = SERVER / 'deployments/menu-order-20261006'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:menu-order-20261006'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-menu-order-baseline-reader'
release.CHECK_NAME = 'mbbs-menu-order-image-check'
MIGRATION = '266_app_menu_order.sql'
NEW_FILES = ['migrations/' + MIGRATION, 'src/menu-order-repository.js', 'src/menu-order-router.js',
             'public/menu-order-model.js', 'public/menu-order.js', 'public/menu-order-admin.html',
             'public/menu-order-admin.js', 'public/menu-order-admin.css']


def capture():
    RELEASE.mkdir(exist_ok=False)
    before = release.metadata(release.APP)
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
    old = json.loads((ARTIFACT / 'workspace-before.json').read_text())
    patch = ''
    for name, digest in old.items():
        original = ARTIFACT / 'workspace-before' / name
        assert release.sha(original.read_bytes()) == digest
        patch += ''.join(difflib.unified_diff(original.read_text().splitlines(True),
            (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name, n=3))
    release.apply_patch(candidate, patch, 'menu-order')
    for name in NEW_FILES:
        assert not (candidate / name).exists(), 'Feature already in live source: ' + name
        shutil.copy2(SERVER / name, candidate / name)
    before_tree, after_tree = release.files_at(baseline), release.files_at(candidate)
    changed = sorted(n for n in before_tree.keys() | after_tree.keys() if before_tree.get(n) != after_tree.get(n))
    assert changed == sorted(list(old) + NEW_FILES), 'Unexpected release scope'
    release.save('manifest.json', {'capturedAt': release.now(), 'app': before, 'dependencies': dependencies,
        'files': changed, 'beforeTree': before_tree, 'candidateTree': after_tree,
        'candidateTreeHash': release.sha(json.dumps(after_tree, sort_keys=True).encode()),
        'workspace': {n: release.sha((SERVER / n).read_bytes()) for n in changed},
        'packages': {n: release.sha((candidate / n).read_bytes()) for n in ['package.json','package-lock.json']}})
    print(json.dumps({'captured': True, 'changedFiles': len(changed)}), flush=True)


def http_check(data, verify_menu=True):
    files = {n: value for n, value in data['candidateTree'].items() if n in data['files'] and n.startswith('public/')}
    paths = {'public/menu-order-admin.html': '/admin/menu-order', 'public/admin.html': '/admin',
             'public/dispatch-menu.html': '/dispatch', 'public/scm-menu.html': '/scm', 'public/sales.html': '/sales'}
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const files=FILES,paths=PATHS,checkMenu=CHECKMENU,results={};
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
let r=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
for(const [name,hash] of Object.entries(files)){
const url=paths[name]||'/'+name.slice(7);
r=await fetch(base+url+'?release=menu-order-20261006',{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});
assert.equal(r.status,200,url);let body=Buffer.from(await r.arrayBuffer());
if(name.endsWith('.html'))body=Buffer.from(body.toString().replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,''));
assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,url);}
if(checkMenu){r=await fetch(base+'/api/navigation/menu-order',{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);
const saved=await r.json();assert.deepEqual(Object.keys(saved).sort(),['orders','revision']);assert.ok(saved.revision>=1);
assert.equal((await fetch(base+'/api/admin/menu-order',{signal:AbortSignal.timeout(15000)})).status,401);}
results[base]={health:200,assets:Object.keys(files).length,...(checkMenu?{publicOrder:200,anonymousAdmin:401}:{})};}
console.log(JSON.stringify(results));""".replace('FILES', json.dumps(files)).replace('PATHS', json.dumps(paths)).replace('CHECKMENU', json.dumps(verify_menu))
    return json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=script.encode(), timeout=100))


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    live = release.metadata(release.APP)
    assert live['imageId'] == data['candidateImageId'] and live['configuration'] == data['app']['configuration']
    assert [release.metadata(n) for n in release.DEPENDENCIES] == data['dependencies']
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    schema = json.loads(release.sql("SELECT json_build_object('migration',(SELECT count(*) FROM schema_migrations WHERE filename='266_app_menu_order.sql'),'settings',(SELECT json_build_object('revision',revision,'orders',orders) FROM app_menu_order_settings WHERE id=true));"))
    assert schema['migration'] == 1
    checked = http_check(data)
    result = {'deployed': True, 'at': release.now(), 'image': release.IMAGE, 'imageId': live['imageId'],
        'candidateTreeHash': data['candidateTreeHash'], 'changedFiles': data['files'],
        'runtimeFilesVerified': len(data['candidateTree']), 'configurationPreserved': True,
        'workerAndDependenciesUnchanged': True, 'schema': schema, 'http': checked}
    release.save('deployment-result.json', result)
    print(json.dumps({'deployed': True, 'http': checked}), flush=True)


def apply():
    data = release.state()
    release.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip() == data['candidateImageId']
    release.config_check(data)
    release.assert_no_active_operations(release.preflight())
    applied = json.loads(release.sql("SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations;"))
    if not (RELEASE / 'schema-before.sql').exists():
        release.save('migrations-before.json', applied)
        with (RELEASE / 'schema-before.sql').open('wb') as output:
            subprocess.run(['docker','exec',release.DB,'pg_dump','-U','mbbs_app','-d','mbbs_yard',
                '--schema-only','--no-owner','--no-acl'],stdout=output,check=True,timeout=30)
    if MIGRATION not in applied:
        start = time.monotonic()
        statement = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
        release.sql("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';\n" + statement
            + "\nINSERT INTO schema_migrations(filename) VALUES('266_app_menu_order.sql'); COMMIT;")
        release.save('migration-result.json',{'filename': MIGRATION, 'seconds':round(time.monotonic()-start,3),'oldAppOnline':True})
    release.current(data)
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
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(release.compose(data,'release')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
        after = release.edit_lease_identities()
        release.save('editing-lease-result.json',{'before':leases,'after':after,'retained':set(leases)<=set(after)})
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data,'rollback')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        release.ready(data['app']['imageId'])
        release.save('rollback-result.json',{'restoredImageId':data['app']['imageId'],'additiveSchemaRetained':True})
        raise
    finally:
        stop.set();thread.join(timeout=2)
        failed = [row['seconds'] for row in samples if not row['ok']]
        recovered = [row['seconds'] for row in samples if row['ok'] and failed and row['seconds']>max(failed)]
        release.save('cutover.json',{'seconds':round(time.monotonic()-start,3),
            'observedInterruptionSeconds':round(min(recovered)-min(failed),3) if recovered else None if failed else 0,'samples':samples})


if __name__ == '__main__':
    {'capture':capture,'build':release.build,'apply':apply,'verify':verify}[sys.argv[1]]()
