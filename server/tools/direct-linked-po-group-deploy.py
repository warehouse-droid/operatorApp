"""Release only the tested split-group mapping and its bounded PO recovery."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('group_release_base', SERVER / 'tools/po-status-waitlist-deploy.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
RELEASE = SERVER / 'deployments/direct-linked-po-group-20261002-v2'
IMAGE = 'mbbs-operator-app:direct-linked-po-group-20261002-v2'
MIGRATION = '257_direct_linked_po_group_completion.sql'
FILES = ['src/dispatch-repository.js', 'migrations/' + MIGRATION]
base.RELEASE, base.IMAGE, base.MIGRATION, base.FILES = RELEASE, IMAGE, MIGRATION, FILES
base.core.RELEASE = RELEASE
docker, metadata, database, save = base.docker, base.metadata, base.database, base.save


def stage():
    capture = json.loads((RELEASE/'capture.json').read_text())
    assert metadata(base.APP) == capture['before']
    tree, old = base.files_at(RELEASE/'candidate'), base.files_at(RELEASE/'before')
    assert sorted(file for file in tree if tree[file] != old.get(file)) == sorted(FILES)
    data = {'services':{'app':{'before':capture['before'],'image':IMAGE}}, 'untouched':capture['untouched'],
        'sourceTree':tree,'sourceHashes':{file:tree[file] for file in FILES},
        'authorization':'Follow-up correction to authorized PO/TO status deployment: SN1401884 is complete.'}
    save('manifest.json',data)
    patch = ''
    for file in FILES:
        original = RELEASE/'before'/file
        patch += ''.join(difflib.unified_diff(original.read_text().splitlines(True) if original.exists() else [],
            (RELEASE/'candidate'/file).read_text().splitlines(True),fromfile='a/'+file if original.exists() else '/dev/null',tofile='b/'+file))
    (RELEASE/'changes.patch').write_text(patch)
    base.current(data)
    print(json.dumps({'releaseStaged':True,'runtimeFiles':2}),flush=True)


def validated(data):
    checks = json.loads((RELEASE/'gauntlet-result.json').read_text())
    assert checks['sourceHashes'] == data['sourceHashes']
    assert checks['tests'] == 128 and checks['failures'] == 0
    assert checks['changedLineCoverage']['coveredLines'] == checks['changedLineCoverage']['executableLines'] > 0
    assert len(checks['mutants']) == 5 and all(row['killed'] for row in checks['mutants'])
    assert checks['reversedOrder'] == {'tests':128,'failed':0}
    assert checks['waitlist'] == {'tests':63,'failed':0}
    assert checks['static'] == {'syntax':'passed','testLint':'passed'}
    for label in ['group-syntax','group-test-syntax','group-lint']:
        assert (RELEASE/(label+'.log')).exists()
    assert base.files_at(RELEASE/'validation-candidate') == data['sourceTree']
    preview = json.loads((RELEASE/'live-candidate-preview.json').read_text())
    assert preview['sourceHashes'] == data['sourceHashes'] and preview['readOnly']
    assert preview['statementTimeoutSeconds'] == 10 and preview['fullScheduleProjectionMs'] < 10000
    assert preview['activeScheduleMs'] is not None and preview['activeScheduleMs'] < 10000


FINGERPRINT = """(SELECT md5(jsonb_build_object(
 'headers',(SELECT jsonb_agg(to_jsonb(po) ORDER BY netsuite_id) FROM purchase_orders po WHERE netsuite_id=-237519275993888),
 'lines',(SELECT jsonb_agg(to_jsonb(line) ORDER BY id) FROM purchase_order_lines line WHERE purchase_order_id=-237519275993888),
 'links',(SELECT jsonb_agg(to_jsonb(link) ORDER BY id) FROM dispatch_so_po_allocations link WHERE po_order_id=-237519275993888),
 'group',(SELECT jsonb_agg(to_jsonb(definition) ORDER BY group_ref) FROM dispatch_global_order_groups definition WHERE group_ref='GOA-9140S1-9143S1'),
 'members',(SELECT jsonb_agg(to_jsonb(member) ORDER BY position) FROM dispatch_global_order_group_members member WHERE group_ref='GOA-9140S1-9143S1'),
 'driver',(SELECT jsonb_agg(to_jsonb(driver) ORDER BY id) FROM driver_job_records driver WHERE id IN (5490,5492)),
 'receipts',(SELECT jsonb_agg(to_jsonb(receipt) ORDER BY id) FROM dispatch_direct_po_ir_jobs receipt WHERE local_po_id=-237519275993888),
 'existingCompletions',(SELECT jsonb_agg(to_jsonb(completion) ORDER BY completion_event_id) FROM dispatch_order_completion_status completion
   WHERE order_ref IN ('LOINC-033146','LOINC-035332','SOA09140-S1','SOA09143-S1')),
 'receiptContract',pg_get_functiondef('dispatch_linked_transport_receipt_ready(text,text)'::regprocedure)
 )::text))"""


def migration(rehearsal=False):
    applied = database("SELECT count(*) FROM schema_migrations WHERE filename='"+MIGRATION+"'")
    if applied == '1':
        original = SERVER / 'deployments/direct-linked-po-group-20261002'
        assert (original/'candidate/migrations'/MIGRATION).read_bytes() == (RELEASE/'candidate/migrations'/MIGRATION).read_bytes()
        assert database("SELECT count(*) FROM dispatch_order_completion_status completion JOIN driver_job_records driver ON driver.id=5492 AND completion.completion_evidence_id=driver.job_id WHERE completion.order_kind='PO' AND completion.order_ref='SN1401884' AND completion.dispatch_completed_at=driver.completed_at AND completion.metadata->>'directShipCoverageVerified'='false' AND completion.metadata->>'directTransportCoverageVerified'='true'") == '1'
        result = {'migration':MIGRATION,'alreadyApplied':True,'exactDriverTimestampRetained':True,'newReceiptJobs':0}
        save('migration-result.json',result)
        print(json.dumps(result),flush=True)
        return
    assert applied == '0'
    definitions = database("SELECT string_agg(pg_get_functiondef(signature::regprocedure),E'\\n') FROM (VALUES ('dispatch_linked_transport_delivery_ready(text,text)'),('dispatch_project_direct_po_link_completion()'),('dispatch_recover_direct_po_transport_completion(bigint)')) functions(signature)")
    (RELEASE/'before-functions.sql').write_text('BEGIN;\n'+definitions+'\nCOMMIT;\n')
    sql = "BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';\n"
    sql += 'CREATE TEMP TABLE group_release_guard ON COMMIT DROP AS SELECT '+FINGERPRINT+' AS fingerprint;\n'
    sql += (RELEASE/'candidate/migrations'/MIGRATION).read_text()+'\n'
    sql += 'DO $guard$ BEGIN IF (SELECT fingerprint FROM group_release_guard) IS DISTINCT FROM '+FINGERPRINT+" THEN RAISE EXCEPTION 'Source, quantities, links, group, Driver, retained completions or receipts changed'; END IF;\n"
    sql += "IF NOT EXISTS (SELECT 1 FROM dispatch_order_completion_status completion JOIN driver_job_records driver ON driver.id=5492 AND completion.completion_evidence_id=driver.job_id WHERE completion.order_kind='PO' AND completion.order_ref='SN1401884' AND completion.dispatch_completed_at=driver.completed_at AND completion.metadata->>'driverJobRecordId'=driver.id::text AND completion.metadata->>'directShipCoverageVerified'='false' AND completion.metadata->>'directTransportCoverageVerified'='true') THEN RAISE EXCEPTION 'Exact SN1401884 delivery proof was not recovered'; END IF; END $guard$;\n"
    sql += "INSERT INTO schema_migrations(filename) VALUES('"+MIGRATION+"'); "+('ROLLBACK' if rehearsal else 'COMMIT')+';\n'
    label = 'migration-rehearsal' if rehearsal else 'migration'
    (RELEASE/(label+'.sql')).write_text(sql)
    started = time.monotonic()
    (RELEASE/(label+'.log')).write_text(database(sql)+'\n')
    result = {'migration':MIGRATION,'rehearsalRolledBack':rehearsal,'committed':not rehearsal,
        'seconds':round(time.monotonic()-started,3),'exactDriverTimestampRetained':True,
        'quantitiesLinksGroupsDriverPriorCompletionsAndReceiptContractUnchanged':True,'newReceiptJobs':0}
    save(label+'-result.json',result)
    print(json.dumps(result),flush=True)


def live(name,verify=False):
    options = ['-e','COMBINED_RELEASE_VERIFY=1'] if verify else []
    result = json.loads(docker('exec','-i',*options,base.APP,'node','--input-type=module',
        input=(SERVER/'tools/direct-linked-po-group-live.mjs').read_bytes()))
    save(name+'.json',result)
    print(json.dumps({'liveCheck':name,'orders':result['orders'],'receiptJobs':result['receiptJobs'],'elapsedMs':result['elapsedMs']}),flush=True)
    return result


def verify():
    data = base.state()
    base.core.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(base.APP)
    assert actual['imageId'] == data['services']['app']['candidateImageId']
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name:metadata(name) for name in base.UNTOUCHED} == data['untouched']
    assert json.loads(docker('exec',base.APP,'node','-e',base.HASH)) == data['sourceTree']
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='"+MIGRATION+"'") == '1'
    orders = live('live-after',verify=True)
    files = ['public/regular-waitlist.js','public/regular-waitlist.css','public/scm-waitlist.js',
        'public/scm-waitlist-list.js','public/sales-stock-requests.html','public/scm-stock-requests.html']
    hashes = {file:data['sourceTree'][file] for file in files}
    code = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES,routes={'public/sales-stock-requests.html':'/sales/stock-requests','public/scm-stock-requests.html':'/scm/stock-requests'};
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health',{signal:AbortSignal.timeout(20000)});assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){const response=await fetch(base+(routes[file]||'/'+file.slice(7)+'?v=20261002-v2'),{signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200);
  const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,file);}
 for(const path of ['/api/scm/schedule','/api/scm/waitlist/pools','/api/sales/stock-requests/waitlist/customers'])assert.equal((await fetch(base+path,{signal:AbortSignal.timeout(20000)})).status,401);
}console.log(JSON.stringify({localAndPublicHealth:true,waitlistAssetsPreserved:6,protectedRoutesVerified:3}));"""
    checks = json.loads(docker('exec','-i',base.APP,'node','--input-type=module',input=code.replace('HASHES',json.dumps(hashes)).encode()))
    result = {'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'image':IMAGE,
        'imageId':actual['imageId'],'runtimeFilesChanged':2,'configurationPreserved':True,
        'workerDatabaseAndOllamaUnchanged':True,'migration':MIGRATION,'orders':orders['orders'],
        'newReceiptJobs':0,**checks}
    save('result.json',result)
    print(json.dumps({'deployed':True,**checks}),flush=True)


base.validated, base.apply_migration, base.live, base.verify = validated, migration, live, verify

if __name__ == '__main__':
    os.umask(0o077)
    {'stage':stage,'prepare':base.prepare,'rehearse':lambda:migration(rehearsal=True),
        'apply':base.apply,'verify':verify,'live-before':lambda:live('live-before')}[sys.argv[1]]()
