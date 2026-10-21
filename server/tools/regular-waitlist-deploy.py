"""Release only the approved waitlist delta over a fresh live source capture."""
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/regular-waitlist-20261002'
OUT = SERVER / 'test-artifacts/regular-waitlist'
FILES = json.loads((SERVER / 'tools/regular-waitlist-files.json').read_text())
IMAGE = 'mbbs-operator-app:regular-waitlist-20261002'
MIGRATION = '254_regular_waitlist.sql'
spec = importlib.util.spec_from_file_location('waitlist_release_core', SERVER / 'tools/regular-stock-resolve-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.OUT, core.FILES, core.IMAGE = RELEASE, OUT, FILES, IMAGE
core.parent.RELEASE, core.parent.OUT, core.parent.FILES, core.parent.IMAGE = RELEASE, OUT, FILES, IMAGE
core.parent.core.RELEASE = RELEASE
APP, docker, metadata = core.APP, core.docker, core.metadata


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = metadata(APP)
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    assert metadata(APP) == before, 'Application changed during capture'
    assert json.loads(docker('exec', APP, 'node', '-e', core.parent.HASH)) == core.parent.core.files_at(baseline)
    core.parent.save('capture.json', {'before': before, 'untouched': {name: metadata(name) for name in core.parent.UNTOUCHED}})
    print(json.dumps({'captured': True, 'parentImage': before['image']}), flush=True)


def stage():
    core.stage()
    candidate = RELEASE / 'candidate'
    assert (candidate / 'package.json').read_bytes() == (RELEASE / 'before/package.json').read_bytes()
    assert (candidate / 'package-lock.json').read_bytes() == (RELEASE / 'before/package-lock.json').read_bytes()


def validation_source():
    core.parent.current(core.parent.state())
    for kind in ['candidate', 'before']:
        target = RELEASE / ('validation-' + kind)
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(RELEASE / kind, target)
        for folder in ['test', 'tools']:
            shutil.copytree(SERVER / folder, target / folder)
        shutil.copy2(SERVER / 'netsuite-smart-scm-picking-ticket-restlet.js', target)
        if kind == 'candidate':
            before = target / 'test-artifacts/regular-waitlist/before'
            for file in FILES:
                source = RELEASE / 'before' / file
                if source.exists():
                    dest = before / file
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, dest)
        remote = '/tmp/mbbs-waitlist-release-' + kind
        docker('exec', 'mbbs-waitlist-review-runner', 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", remote)
        docker('cp', str(target) + '/.', 'mbbs-waitlist-review-runner:' + remote)
        docker('exec', 'mbbs-waitlist-review-runner', 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", remote)
    print(json.dumps({'releaseValidationSourcesReady': True}), flush=True)


def verify():
    data = core.parent.state()
    core.parent.core.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == data['services']['app']['candidateImageId']
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in core.parent.UNTOUCHED} == data['untouched']
    assert json.loads(docker('exec', APP, 'node', '-e', core.parent.HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    assert core.parent.database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '1'
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES,routes={'public/sales-stock-requests.html':'/sales/stock-requests','public/scm-stock-requests.html':'/scm/stock-requests'};let publicReadRetries=0;
async function read(url,options={}){for(let attempt=1;attempt<=3;attempt++){try{return await fetch(url,{...options,signal:AbortSignal.timeout(30000)});}catch(error){if(attempt===3||!url.startsWith('https://test.mbbsoperation.com/')||error.cause?.code!=='UND_ERR_CONNECT_TIMEOUT')throw error;publicReadRetries++;await new Promise(resolve=>setTimeout(resolve,attempt*1000));}}}
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await read(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;const response=await read(base+(routes[file]||'/'+file.slice(7)),{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200,file);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,file);}
 for(const path of ['/api/scm/waitlist/pools','/api/sales/stock-requests/waitlist/customers'])assert.equal((await read(base+path)).status,401);
}
console.log(JSON.stringify({health:true,publicAssets:true,waitlistRoutesProtected:true,publicReadRetries,productionSalesOrdersCreated:0}));"""
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.replace('HASHES', json.dumps(data['sourceHashes'])).encode()))
    core.parent.save('result.json', {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'image': IMAGE, 'imageId': actual['imageId'], 'configurationPreserved': True, 'untouchedServicesPreserved': True, 'migration': MIGRATION, **live})
    print(json.dumps({'deployed': True, **live}), flush=True)


def apply():
    data = core.parent.state()
    core.parent.current(data)
    core.validate_candidate()
    core.parent.core.config_check(data)
    active = json.loads(core.parent.database("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    core.parent.save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    if core.parent.database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '0':
        core.parent.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" +
            (RELEASE / 'candidate/migrations' / MIGRATION).read_text() +
            "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;")
        core.parent.save('migration-result.json', {'applied': MIGRATION, 'transactional': True, 'additive': True})
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.parent.core.compose(data) + ['up','-d','--no-build','--no-deps','--pull','never','app'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.parent.core.compose(data,'compose.rollback.yml') + ['up','-d','--no-build','--no-deps','--pull','never','app'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.parent.core.core.ready(data['services']['app']['before']['imageId'])
        core.parent.save('rollback-result.json', {'restoredPreviousApp': True, 'additiveWaitlistSchemaRetained': True})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'capture':capture,'stage':stage,'validation-source':validation_source,'prepare':core.prepare,'apply':apply,'verify':verify}[sys.argv[1]]()
