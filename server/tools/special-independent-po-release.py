"""Scoped independent-PO release over the exact current application image."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('independent_po_release', SERVER/'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER/'deployments/special-independent-po-20261029'
release.IMAGE = 'mbbs-operator-app:special-independent-po-20261029'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-independent-po-20261029'
EXISTING = ['src/special-stock-request-service.js','src/special-stock-request-repository.js',
    'src/special-stock-request-netsuite.js','src/special-stock-local-adjustments.js',
    'src/netsuite.js','src/server.js','public/scm-special-stock-requests.js','public/scm-stock-requests.html']
MIGRATION = '322_special_independent_po.sql'
ADDED = ['src/special-stock-purchase-units.js','src/special-stock-purchase-review.js',
    'public/special-stock-po-editor.js','migrations/'+MIGRATION]
release.FILES = sorted(EXISTING+ADDED)


def db(sql):
    return release.docker('exec','-i','mbbs-operator-app-db-1','psql','-U','mbbs_app','-d','mbbs_yard',
        '-XAt','-v','ON_ERROR_STOP=1',input=sql.encode()).decode().strip()


def idle():
    assert db("""SELECT
      (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')) +
      (SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')) +
      (SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing') +
      (SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating'
        OR purchase_order_operation_status='creating');""") == '0', 'Wait for active writes before cutover'


def prepare():
    out=release.RELEASE
    out.mkdir(parents=True,exist_ok=True)
    assert not (out/'manifest.json').exists(), 'A prepared release already exists'
    info={'app':release.core.metadata(release.APP),
          'dependencies':[release.core.metadata(name) for name in release.DEPENDENCIES]}
    before=out/'live-before'
    for draft in [before,out/'candidate']:shutil.rmtree(draft,ignore_errors=True)
    before.mkdir()
    subprocess.run(['tar','--no-same-owner','-xf','-','-C',str(before)],check=True,
        input=release.docker('exec',release.APP,'tar','-C','/app','-cf','-',
            'src','public','migrations','package.json','package-lock.json'))
    candidate=out/'candidate';shutil.copytree(before,candidate)
    baseline=Path('/tmp/mbbs-special-independent-po-baseline')
    patch=''
    for file in EXISTING:
        old=(baseline/file).read_text();new=(SERVER/file).read_text();live=(before/file).read_text()
        if file=='src/special-stock-request-netsuite.js':
            # Live still has a narrower SO packing rule. Preserve that rule;
            # this release only adds packing to purchase payloads.
            old=live
            anchor='  // Transaction units are scalar IDs in REST, unlike item/entity references.'
            assert old.count(anchor)==1
            new=old.replace(anchor,'  if (purchase) Object.assign(payload, specialPackPayload(line));\n'+anchor)
        if file=='public/scm-stock-requests.html' and live==new:continue
        patch+=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+file,tofile='b/'+file))
    (out/'release.patch').write_text(patch)
    result=subprocess.run(['patch','--batch','--forward','--fuzz=0','-p1','-d',str(candidate)],
        input=patch,text=True,capture_output=True)
    (out/'patch.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0, 'Review scoped patch conflicts before continuing'
    for file in ADDED:
        assert not (before/file).exists(), 'New file already exists: '+file
        shutil.copy2(SERVER/file,candidate/file)
    for path in candidate.rglob('*.orig'):path.unlink()
    before_files=release.core.files_at(before);after_files=release.core.files_at(candidate)
    changed=sorted(file for file,digest in after_files.items() if before_files.get(file)!=digest)
    assert set(changed)==set(release.FILES)-{'public/scm-stock-requests.html'} or changed==release.FILES
    info['files']={file:release.digest(candidate/file) for file in release.FILES}
    release.save('manifest.json',info);release.current(info)
    print(json.dumps({'prepared':True,'files':len(release.FILES),'baseImage':info['app']['imageId']}),flush=True)


def validate():
    info=release.state();release.current(info)
    env=dict(os.environ,MBBS_SPECIAL_RUNTIME_DIR=str(release.RELEASE/'candidate'))
    result=subprocess.run(['bash',str(SERVER.parent/'docker/run-special-independent-po-tests.sh')],
        env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    print(result.stdout,flush=True)
    assert result.returncode==0, 'Candidate checks failed'
    evidence=json.loads(next(line.removeprefix('RESULT_JSON ') for line in result.stdout.splitlines() if line.startswith('RESULT_JSON ')))
    assert evidence['passed'] and evidence['files']==info['files'], 'Checks did not exercise this exact candidate'
    release.current(info);release.save('verified.json',evidence)


def build():
    info=release.state();release.current(info)
    evidence=json.loads((release.RELEASE/'verified.json').read_text())
    assert evidence['passed'] and evidence['files']==info['files']
    release.docker('tag',info['app']['imageId'],release.ROLLBACK)
    context=release.RELEASE/'image-context'
    try:
        for file in release.FILES:
            target=context/'payload'/file;target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(release.RELEASE/'candidate'/file,target)
        (context/'Dockerfile').write_text('FROM '+release.ROLLBACK+'\nCOPY --chown=node:node payload/ /app/\n')
        subprocess.run(['sudo','-n','docker','build','--network=none','--pull=false','-t',release.IMAGE,str(context)],check=True)
    finally:shutil.rmtree(context,ignore_errors=True)
    info['imageId']=release.docker('image','inspect','--format','{{.Id}}',release.IMAGE).decode().strip()
    for name,tag in [('compose.release.yml',release.IMAGE),('compose.rollback.yml',release.ROLLBACK)]:
        (release.RELEASE/name).write_text('services:\n  app:\n    image: '+tag+'\n')
    release.save('manifest.json',info);release.current(info)
    print(json.dumps({'built':True,'imageId':info['imageId']}),flush=True)


def migrate():
    info=release.state();release.current(info);idle()
    evidence=json.loads((release.RELEASE/'verified.json').read_text())
    assert evidence['passed'] and evidence['files']==info['files']
    if db("SELECT filename FROM schema_migrations WHERE filename='"+MIGRATION+"';"):return
    constraint=db("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='sales_special_stock_order_lines'::regclass AND conname='sales_special_stock_order_line_case_check';")
    assert constraint
    release.save('constraint-before.json',{'constraint':constraint})
    sql=(release.RELEASE/'candidate/migrations'/MIGRATION).read_text()
    db("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n"+sql+
       "\nINSERT INTO schema_migrations(filename) VALUES ('"+MIGRATION+"'); COMMIT;")
    release.save('migration-result.json',{'migration':MIGRATION,'applied':True,
        'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
    print(json.dumps({'migration':MIGRATION,'applied':True}),flush=True)


def verify():
    info=release.state();release.core.ready(info['imageId'])
    assert release.core.metadata(release.APP)['configuration']==info['app']['configuration']
    assert [release.core.metadata(name) for name in release.DEPENDENCIES]==info['dependencies']
    rows=release.docker('exec',release.APP,'sha256sum',*['/app/'+file for file in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'):row.split()[0] for row in rows}==info['files']
    assert db("SELECT count(*) FROM schema_migrations WHERE filename='"+MIGRATION+"';")=='1'
    script="""import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {listSpecialPurchaseUnitsFromNetSuite} from './src/netsuite.js';
import {closeDb} from './src/db.js';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,digest] of Object.entries(FILES)) {
  const response=await fetch(base+'/'+file.replace('public/','')+'?independentPo=20261029');
  assert.equal(response.status,200);assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),digest);
 }
 assert.equal((await fetch(base+'/api/scm/special-stock-requests/items/2055/units')).status,401);
}
const catalogs=[];
try {
 for(const itemId of [2055,1784]) {
  const catalog=await listSpecialPurchaseUnitsFromNetSuite(itemId);
  assert.ok(catalog.noUnits || catalog.units.length>0);
  catalogs.push({itemId,units:catalog.units.map(unit=>unit.name),noUnits:catalog.noUnits});
 }
}finally {await closeDb();}
console.log(JSON.stringify({health:200,assets:'verified',anonymousAccess:401,netsuiteCatalogs:catalogs}));
"""
    assets={file:digest for file,digest in info['files'].items() if file.startswith('public/')}
    result=json.loads(release.docker('exec','-i',release.APP,'node','--input-type=module',input=script.replace('FILES',json.dumps(assets)).encode()))
    result.update({'deployed':True,'imageId':info['imageId'],'configurationPreserved':True,
        'dependenciesUnchanged':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
    release.save('deployment-result.json',result);print(json.dumps(result),flush=True)


def apply():
    idle();release.apply()


release.verify=verify
if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':build,'migrate':migrate,'apply':apply,'verify':verify}[sys.argv[1]]()
