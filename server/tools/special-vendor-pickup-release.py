#!/usr/bin/env python3
"""Release vendor-yard pickup completion, the nightly vendor-pickup refresh, and SO/PO replacement.

1. Special requests with "Customer pickup at vendor yard": an approved PO with an SCM reference in
   Queued (or a later transport status) moves to Dispatch Arrangement, and the request completes
   once its linked SO is fulfilled or billed; the PO receipt is no longer required (migration 331
   and public/special-stock-workflow.js). Backorder vendor pickup is unchanged.
2. The nightly aggregate reconciliation also force-refreshes the SO/PO status of every open Special
   vendor pickup, so a billed SO completes it without a webhook or a page view.
3. Sales can replace a linked SO and SCM can replace a linked PO (new synced order number plus a
   reason, audited); the request then follows the manual-link rules.

The candidate is the live copy plus deployments/special-vendor-pickup-20261104/change.patch (only
this change, strict context, no fuzz); unrelated workspace edits (e.g. server.js AI chat) are never
released. Migration 331 only replaces two views (same columns); deploy restores the previous view
definitions if the app is rolled back.

Steps: prepare -> validate -> build -> deploy (applies 331, verifies; rolls back on failure) -> verify.
Validation reuses the existing e2e test image (no build) with each tree's src/public/migrations
mounted, in a bounded, labelled, always-torn-down network; every test file gets its own cloned
database. Live must fail the new tests, the candidate must pass them, and the candidate must add no
failure to the related suites.
"""
import json,os,re,runpy,signal,subprocess,sys,time
from pathlib import Path

release=runpy.run_path(str(Path(__file__).with_name('split-ref-status-release.py')))
split=release['prepare'].__globals__
sor=split['sor']
base=split['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/special-vendor-pickup-20261104'
PATCH=OUT/'change.patch'
MIGRATION='331_special_vendor_pickup_completion.sql'
FILES=['src/special-stock-request-repository.js','src/special-vendor-pickup-refresh.js','src/aggregate-reconciliation-service.js',
  'src/server.js','public/special-stock-workflow.js','public/sales-special-stock-requests.js','public/scm-special-stock-requests.js',
  'public/stock-requests.css','public/sales-stock-requests.html','public/scm-stock-requests.html','migrations/'+MIGRATION]
NEW_FILES={'src/special-vendor-pickup-refresh.js','migrations/'+MIGRATION}
IMAGE='mbbs-operator-app:special-vendor-pickup-20261104'
ROLLBACK='mbbs-operator-app:special-vendor-pickup-rollback-20261104'
TEST_IMAGE='mbbs-mbt-p1-test-e2e:latest'
TARGET_FILES=['test/mbt/integration/special-vendor-pickup-replacement.test.js','test/mbt/unit/special-order-replacement.browser.test.js']
REGRESSION=[
  'test/mbt/unit/aggregate-nightly-service.test.js','test/mbt/unit/special-po-dispatch-stage.test.js',
  'test/mbt/unit/special-approval-fulfillment.test.js','test/mbt/unit/special-workflow-polish.test.js',
  'test/mbt/unit/special-workflow-review.test.js','test/mbt/unit/special-stock-request-domain.red.test.js',
  'test/mbt/unit/special-manual-so-ui.browser.test.js','test/mbt/unit/special-independent-po.test.js',
  'test/mbt/unit/special-child-po.test.js',
  'test/mbt/integration/special-po-dispatch-stage.test.js','test/mbt/integration/special-vendor-confirmation.test.js',
  'test/mbt/integration/special-line-decline-http.test.js','test/mbt/integration/special-custom-po-http.test.js',
  'test/mbt/integration/special-custom-po-browser.test.js','test/mbt/integration/special-manual-so-link.test.js',
  'test/mbt/integration/special-child-po.test.js','test/mbt/integration/special-independent-po.test.js',
  'test/mbt/integration/special-stock-updates.test.js','test/mbt/integration/special-customer-confirmation.test.js',
  'test/mbt/integration/special-workflow-closure.test.js','test/mbt/integration/special-approval-http.test.js',
  'test/mbt/integration/special-shared-orders.test.js','test/mbt/integration/special-status-following.test.js',
  'test/mbt/integration/special-po-reference-http.test.js','test/mbt/integration/special-workflow-polish.test.js',
  'test/mbt/integration/aggregate-nightly-schedule.test.js','test/mbt/integration/aggregate-nightly.test.js',
  'test/mbt/integration/backorder-review-flow.test.js','test/mbt/integration/backorder-already-ordered.test.js',
  'test/mbt/integration/backorder-requests.test.js']
# The released patch must carry these, and nothing from other workspace work.
MARKERS={'src/special-stock-request-repository.js':'replaceSpecialPurchaseOrder','src/special-vendor-pickup-refresh.js':'refreshOpenSpecialVendorPickupOrders',
  'src/aggregate-reconciliation-service.js':'nightlySpecialVendorPickupRefresh','src/server.js':'replaceSpecialSalesOrder',
  'public/special-stock-workflow.js':'specialPurchaseOrderDispatchReady(evidence)) return','public/sales-special-stock-requests.js':'data-special-replace-so-form',
  'public/scm-special-stock-requests.js':'data-special-po-replace-form','public/stock-requests.css':'special-order-replacements',
  'public/sales-stock-requests.html':'replaceOrders=20261104-v1','public/scm-stock-requests.html':'replaceOrders=20261104-v1',
  'migrations/'+MIGRATION:"WHEN 'vendor_pickup' THEN CASE WHEN workflow_kind = 'special'"}
for scope in (split,sor):scope.update(OUT=OUT)
split.update(PATCH=PATCH,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
save,sha=base['save'],base['sha']

def apply_migration():
    db=base['db']
    if db(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}';"):
        return {'filename':MIGRATION,'alreadyApplied':True}
    sql=(OUT/'candidate/migrations'/MIGRATION).read_text()
    db("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"+sql+
      f"\nINSERT INTO schema_migrations(filename) VALUES ('{MIGRATION}'); COMMIT;")
    return {'filename':MIGRATION,'applied':True,'sha256':sha(OUT/'candidate/migrations'/MIGRATION)}
base['apply_migration']=apply_migration

def view_section(path,start,end=None):
    text=path.read_text()
    body=text[text.index(start):]
    return body[:body.index(end)] if end else body

def rollback_schema():
    """The view definitions live before this release: completion from 321, stages from 296."""
    live=OUT/'live-before/migrations'
    completion=view_section(live/'321_special_child_po.sql','CREATE OR REPLACE VIEW special_stock_completion_evidence','\nFROM classified;')+'\nFROM classified;\n'
    stages=view_section(live/'296_special_vendor_confirmation.sql','CREATE OR REPLACE VIEW special_stock_workflow_stages')
    assert "WHEN 'vendor_pickup' THEN purchase_netsuite_received AND sales_netsuite_fulfilled" in completion
    assert "AND special.fulfillment_method <> 'vendor_pickup'" in stages
    return completion+'\n'+stages

def changed_files(live,candidate):
    names=set()
    for root in (live,candidate):
        for path in root.rglob('*'):
            if path.is_file():names.add(str(path.relative_to(root)))
    return sorted(n for n in names if not ((live/n).is_file() and (candidate/n).is_file()
      and (live/n).read_bytes()==(candidate/n).read_bytes()))

def prepare():
    state=sor['capture']()
    live,candidate=OUT/'live-before',OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(live),str(candidate)],check=True)
    for name in NEW_FILES:assert not (live/name).exists(),name+' already live'
    with PATCH.open('rb') as patch:
        subprocess.run(['patch','-p2','--fuzz=0','--no-backup-if-mismatch','--batch','-d',str(candidate)],stdin=patch,check=True)
    differs=changed_files(live,candidate)
    assert differs==sorted(FILES),('Candidate must differ from live in exactly the release files',differs)
    diff=[]
    for name in FILES:
        old=str(live/name) if (live/name).exists() else '/dev/null'
        one=subprocess.run(['git','diff','--no-index','--',old,str(candidate/name)],capture_output=True,text=True).stdout
        added=[line for line in one.splitlines() if line.startswith('+') and not line.startswith('+++')]
        assert any(MARKERS[name] in line for line in added),name
        assert not any(word in line for line in added for word in ('aiChat','ai-chat','AiChat','autoRetry','adminRepost')),\
            f'{name}: unrelated workspace work in candidate'
        diff.append(one)
    server=[l for l in diff[FILES.index('src/server.js')].splitlines() if l[:1] in '+-' and l[:3] not in ('+++','---')]
    assert len(server)==22 and all(l.startswith('+') for l in server),('server.js must add only the two routes, imports and nightly logging',len(server))
    (OUT/'release.patch').write_text(''.join(diff))
    (OUT/'rollback-schema.sql').write_text(rollback_schema())
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'patchSha256':sha(PATCH),'conflicts':[],
      'moduleBasis':{name:'live plus change.patch' for name in FILES},
      'sourceHashes':{name:sha(candidate/name) for name in FILES}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'patchLines':sum(len(d.splitlines()) for d in diff)}))

RUNNER=r'''
import { buildIsolatedTestEnvironment } from '/app/test/support/test-foundation.mjs';
import { runNodeTestFilesIsolated } from '/app/test/support/test-database-isolation.mjs';
process.chdir('/app');
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: String(process.env.DATABASE_URL || '') });
process.exitCode = await runNodeTestFilesIsolated(process.argv.slice(2), { environment, label: 'release' });
'''
TEST_ENV={'NODE_ENV':'test','MBT_TEST_ISOLATED':'1','MBBS_ENV_FILE':'.env.mbt-test-does-not-exist','XDG_CONFIG_HOME':'/tmp/cfg',
  'XDG_CACHE_HOME':'/tmp/cache','PORT':'3000','MBT_ENABLED':'true','MBT_CUSTOMER_SYNC_ENABLED':'false','MBT_MASTER_DATA_ENABLED':'false',
  'MBT_ASSET_MANAGEMENT_ENABLED':'false','MBT_FRONTDESK_OPERATIONS_ENABLED':'false','MBT_BIN_DISPATCH_ENABLED':'false',
  'MBT_DRIVER_EXECUTION_ENABLED':'false','MBT_BILLING_OPERATIONS_ENABLED':'false','MBT_NETSUITE_WRITES_ENABLED':'false',
  'NETSUITE_ACCOUNT_ID':'','NETSUITE_CLIENT_ID':'','NETSUITE_CLIENT_SECRET':'','NETSUITE_M2M_STORAGE_SECRET':'',
  'NETSUITE_M2M_SETTINGS_PATH':'/app/data/netsuite-m2m-settings.json','NETSUITE_M2M_MASTER_KEY_PATH':'/app/data/.netsuite-m2m-master-key',
  'NETSUITE_DIRECT_ACCESS_ENABLED':'false','NETSUITE_WEBHOOK_SECRET':'mbt_test_webhook_stress_secret','NETSUITE_MIRROR_ROLE':'disabled',
  'NETSUITE_MIRROR_SHARED_SECRET':'','SMART_SCM_LIVE_EXECUTION_ENABLED':'false','SMART_SCM_PICKING_TICKET_RESTLET_URL':'',
  'SAMSARA_API_TOKEN':'','SAMSARA_WRITES_ENABLED':'false','GOOGLE_MAPS_API_KEY':'','PHOTO_UPLOAD_PROVIDER':'local_data_url',
  'PHOTO_UPLOAD_TOKEN_SECRET':'','PHOTO_UPLOAD_WORKER_URL':'','SALES_PUBLIC_ACCESS_ENABLED':'false',
  'DISPATCH_PLANNER_ORDER_POOL_MODE':'off','DISPATCH_PLANNER_COMMAND_MODE':'off','OLLAMA_BASE_URL':'http://127.0.0.1:9'}

def spec(text):
    """Per file: top-level spec results, plus a file-level failure when the isolated runner reports it."""
    results,current={},None
    for line in text.splitlines():
        header=re.match(r'^\[isolation\] release \d+/\d+ (\S+)$',line)
        if header:
            current=header.group(1);results.setdefault(current,{'passed':set(),'failed':set()});continue
        row=re.match(r'^(✔|✖) (.+?) \([\d.]+m?s\)$',line)
        if current and row:results[current]['passed' if row.group(1)=='✔' else 'failed'].add(row.group(2))
    summary=re.search(r'^Isolated release run failed in \d+/\d+ file\(s\): (.+)$',text,re.M)
    for name in (summary.group(1).split(', ') if summary else []):
        results.setdefault(name,{'passed':set(),'failed':set()})['failed'].add('FILE EXIT')
    for value in results.values():value['passed']-=value['failed']
    return results

def suite(art):
    tag=f'mbbs-special-vendor-pickup-{os.getpid()}'
    net,db=tag+'-net',tag+'-db'
    labels=['--label','com.mbbs.lifecycle=disposable-test','--label','com.mbbs.harness='+tag]
    harness=OUT/'harness';harness.mkdir(exist_ok=True);(harness/'run-isolated.mjs').write_text(RUNNER)
    for path in [harness,*harness.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    def docker(*args,**kw):return subprocess.run(['docker',*args],capture_output=True,text=True,**kw)
    def node(tree,*command,timeout=5400):
        env=[]
        for key,value in {**TEST_ENV,'DATABASE_URL':'postgres://mbt_test:mbt_test_password@db:5432/mbt_test'}.items():env+=['-e',f'{key}={value}']
        return docker('run','--rm','--name',f'{tag}-run-{os.urandom(3).hex()}','--network',net,*labels,
          '--cgroup-parent=mbbs-tests.slice','--init','--cpus','2','--memory','2g','--memory-swap','2g','--pids-limit','512','--read-only',
          '--tmpfs','/app/data:uid=1000,gid=1000,mode=0700,size=128m','--tmpfs','/tmp:uid=1000,gid=1000,mode=1777,size=512m',
          '-v',f'{tree}/src:/app/src:ro','-v',f'{tree}/public:/app/public:ro','-v',f'{tree}/migrations:/app/migrations:ro',
          '-v',f'{SERVER}/test:/app/test:ro','-v',f'{harness}:/harness:ro','-v',f'{art}:/app/test-artifacts',
          *env,TEST_IMAGE,*command,timeout=timeout)
    def psql(sql):
        result=docker('exec',db,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','mbt_test','-d','postgres','-c',sql)
        assert result.returncode==0,result.stderr
    results={}
    try:
        assert docker('network','create','--internal',*labels,net).returncode==0
        started=docker('run','-d','--rm','--name',db,'--network',net,'--network-alias','db',*labels,'--cgroup-parent=mbbs-tests.slice','--init',
          '--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','256',
          '--tmpfs','/var/lib/postgresql:size=768m','-e','POSTGRES_DB=mbt_test','-e','POSTGRES_USER=mbt_test',
          '-e','POSTGRES_PASSWORD=mbt_test_password','-e','PGDATA=/var/lib/postgresql/data',
          'postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15')
        assert started.returncode==0,started.stderr
        for _ in range(60):
            if docker('exec',db,'pg_isready','-U','mbt_test','-d','mbt_test').returncode==0:break
            time.sleep(1)
        time.sleep(2)
        for label,tree in [('live',OUT/'live-before'),('candidate',OUT/'candidate')]:
            checked=[name for name in FILES if name.endswith('.js') and (tree/name).exists()]
            check=node(tree,'sh','-ec',' '.join(f'node --check {name};' for name in checked))
            assert check.returncode==0,(label,check.stderr[-2000:])
            # Each tree gets a fresh template database; every test file then runs on its own clone.
            psql('DROP DATABASE IF EXISTS mbt_test WITH (FORCE)');psql('CREATE DATABASE mbt_test')
            migrate=node(tree,'npm','run','--silent','migrate')
            (art/f'migrate-{label}.log').write_text(migrate.stdout+migrate.stderr)
            assert migrate.returncode==0,(migrate.stdout+migrate.stderr)[-3000:]
            run=node(tree,'node','/harness/run-isolated.mjs',*TARGET_FILES,*REGRESSION)
            (art/f'{label}.log').write_text(run.stdout+run.stderr)
            results[label]=spec(run.stdout+'\n'+run.stderr)
            # The isolation runner requires host 'db'; an empty parse means the runner itself failed.
            assert results[label],(label,'no test results parsed',(run.stdout+run.stderr)[-3000:])
        return results
    finally:
        ids=docker('ps','-aq','--filter','label=com.mbbs.harness='+tag).stdout.split()
        if ids:docker('rm','-f','-v',*ids)
        docker('network','rm',net)
        assert not docker('ps','-aq','--filter','label=com.mbbs.harness='+tag).stdout.strip(),tag+' containers remain'
        assert docker('network','inspect',net).returncode!=0,tag+' network remains'
        subprocess.run(['rm','-rf','--',str(harness)],check=True)

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    prepared=base['ensure_sources']();art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    subprocess.run(['python3','docker/verify-memory-limits.py'],cwd=REPO,check=True,capture_output=True)
    tests={name:sha(SERVER/name) for name in [*TARGET_FILES,*REGRESSION]}
    results=suite(art)
    live,cand=results['live'],results['candidate']
    pick=lambda tree,files,kind:sorted(f'{f} :: {n}' for f in files for n in tree.get(f,{}).get(kind,()))
    checks={
      'liveTarget':{'passed':len(pick(live,TARGET_FILES,'passed')),'failed':len(pick(live,TARGET_FILES,'failed'))},
      'candidateTarget':{'passed':len(pick(cand,TARGET_FILES,'passed')),'failed':pick(cand,TARGET_FILES,'failed')},
      'live':{'passed':len(pick(live,REGRESSION,'passed')),'failed':len(pick(live,REGRESSION,'failed'))},
      'candidate':{'passed':len(pick(cand,REGRESSION,'passed')),'failed':len(pick(cand,REGRESSION,'failed'))},
      'missingFiles':sorted(f for f in [*TARGET_FILES,*REGRESSION] if f not in cand or f not in live),
      'newFailures':sorted(set(pick(cand,REGRESSION,'failed'))-set(pick(live,REGRESSION,'failed'))),
      'liveOnlyFailures':sorted(set(pick(live,REGRESSION,'failed'))-set(pick(cand,REGRESSION,'failed'))),
      'preexistingFailures':sorted(set(pick(cand,REGRESSION,'failed'))&set(pick(live,REGRESSION,'failed'))),
      'testHashes':tests}
    save(OUT/'validation-checks.json',checks)
    ok=(checks['candidateTarget']['passed']==9 and not checks['candidateTarget']['failed'] and checks['liveTarget']['failed']>0
        and not checks['missingFiles'] and not checks['newFailures'] and checks['candidate']['passed']>=checks['live']['passed']>0)
    assert ok,('Validation failed',json.dumps({k:v for k,v in checks.items() if k!='testHashes'},indent=1)[-8000:])
    assert {name:sha(SERVER/name) for name in tests}==tests,'Tests changed during validation'
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    save(OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
      'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed','liveTargetFailed':checks['liveTarget']['failed'],
      'candidateTargetPassed':checks['candidateTarget']['passed'],'live':checks['live'],'candidate':checks['candidate'],
      'liveOnlyFailures':len(checks['liveOnlyFailures']),'preexistingFailures':len(checks['preexistingFailures'])}))

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; prepare and validate again'
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    built=json.loads((OUT/'built.json').read_text())['imageId']
    try:
        base['deploy']()
    except BaseException:
        # The app was rolled back (or never switched): restore the views the previous image expects.
        audit=json.loads((OUT/'migration-audit.json').read_text()) if (OUT/'migration-audit.json').exists() else {}
        if audit.get('applied') and base['metadata'](APP)['imageId']!=built:
            base['db']("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"+(OUT/'rollback-schema.sql').read_text()+
              f"\nDELETE FROM schema_migrations WHERE filename='{MIGRATION}'; COMMIT;")
            save(OUT/'schema-rollback.json',{'restoredAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'views':['special_stock_completion_evidence','special_stock_workflow_stages']})
        raise
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n'
      +f'# then restore the views: psql < {OUT}/rollback-schema.sql and DELETE FROM schema_migrations WHERE filename=\'{MIGRATION}\'\n')

LIVE_CHECK=r'''
const workflow = await import("/app/public/special-stock-workflow.js");
const repository = await import("/app/src/special-stock-request-repository.js");
const refresh = await import("/app/src/special-vendor-pickup-refresh.js");
const queued = { salesOrderId: 1, purchaseOrderId: 2, purchaseOrderApproved: true, fulfillmentMethod: "vendor_pickup",
  purchaseOrderReference: "REF", purchaseOrderDispatchStatus: "Queued" };
console.log(JSON.stringify({ vendorPickupQueued: workflow.specialStage(queued),
  replaceSo: typeof repository.replaceSpecialSalesOrder, replacePo: typeof repository.replaceSpecialPurchaseOrder,
  nightly: typeof refresh.refreshOpenSpecialVendorPickupOrders }));
process.exit(0);
'''

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    checks=[]
    for method,path,expected in [('POST','/api/sales/special-stock-requests/1/sales-order/replace',401),
        ('POST','/api/scm/special-stock-requests/1/purchase-order/replace',401),('GET','/sales/stock-requests',200),('GET','/scm/stock-requests',200)]:
        code=int(subprocess.check_output(['curl','-sS','--max-time','15','-X',method,'-o','/dev/null','-w','%{http_code}',
          'http://127.0.0.1:3000'+path],text=True))
        assert code==expected,f'{path}: {code}'
        checks.append({'method':method,'path':path,'status':code})
    for asset,marker in [('/sales-special-stock-requests.js','data-special-replace-so-form'),('/scm-special-stock-requests.js','data-special-po-replace-form')]:
        body=subprocess.check_output(['curl','-fsS','--max-time','15','http://127.0.0.1:3000'+asset],text=True)
        assert marker in body,asset
    loaded=json.loads(base['docker']('exec','-i','-w','/app',APP,'node','--input-type=module',data=LIVE_CHECK.encode()).splitlines()[-1])
    assert loaded=={'vendorPickupQueued':'dispatch_arrangement','replaceSo':'function','replacePo':'function','nightly':'function'},loaded
    db=base['db']
    assert db(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}';")==MIGRATION
    views=db("SET default_transaction_read_only=on; SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass)||pg_get_viewdef('special_stock_completion_evidence'::regclass);")
    assert "<> 'vendor_pickup'" not in views and "workflow_kind = 'special'" in views,'Migration 331 views are not live'
    stages=db("SET default_transaction_read_only=on; SELECT string_agg(r.request_ref||'='||w.stage,',' ORDER BY r.request_ref)"
      " FROM special_stock_workflow_stages w JOIN sales_stock_requests r ON r.id=w.request_id"
      " JOIN sales_special_stock_cases s ON s.request_id=w.request_id"
      " WHERE s.workflow_kind='special' AND s.fulfillment_method='vendor_pickup' AND s.close_status='active'"
      " AND r.request_ref IN ('SPREQ-000154','SPREQ-000159','SPREQ-000161','SPREQ-000168','SPREQ-000178','SPREQ-000180','SPREQ-000181');")
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks,'modules':loaded,'vendorPickupStages':stages})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks),'modules':loaded,'vendorPickupStages':stages}))
base['verify']=verify

if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':split['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()
