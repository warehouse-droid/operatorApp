#!/usr/bin/env python3
"""Release SCM line details, SCM vendor correction, manual-SO decision clearing and SO delivery updates.

1. SCM can change Required date, Supply status, Vendor, Vendor pickup location, Sales-visible reply and
   SCM internal note on accepted lines at any time while the request is open, including after the SO/PO
   are linked. These are request details; the NetSuite SO and PO are not changed.
2. SCM can correct the case vendor (one vendor per Special request; every line follows it). A linked
   NetSuite PO keeps its vendor; the change is audited.
3. Sales and SCM see the Sales-visible reply with the time SCM last changed it (migration 332 adds the
   timestamp and backfills it from the last stock check).
4. A manual SO link clears the "line decisions changed" flag (it blocked PO creation on SPREQ-000182);
   migration 332 clears it on existing manually linked requests.
5. The SO delivery-method update accepts NetSuite Subtotal/Description rows and quantity-less discount
   rows on manually created SOs (SPREQ-000182 failed with "exact NetSuite order and line identities").
   They are compared, never rewritten; order adjustments keep the strict line checks.

The candidate is the live copy plus deployments/special-scm-line-details-20261104/change.patch (only
this change, strict context, no fuzz). Migration 332 is additive: on an app rollback the previous image
ignores the new columns, so no schema rollback is needed.

Steps: patch -> prepare -> validate -> build -> deploy (applies 332, verifies; rolls the app back on
failure) -> verify. Validation reuses the e2e test image (no build) exactly as the vendor-pickup
release does: each tree on a fresh database, every test file on its own clone.
"""
import json,os,runpy,signal,subprocess,sys
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-vendor-pickup-release.py')))
prev=previous['prepare'].__globals__
split,sor,base=prev['split'],prev['sor'],prev['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/special-scm-line-details-20261104'
PATCH=OUT/'change.patch'
MIGRATION='332_special_scm_line_details.sql'
FILES=['src/special-stock-request-repository.js','src/special-stock-rest-orders.js','src/special-stock-fulfillment-adapter.js',
  'public/scm-special-stock-requests.js','public/sales-special-stock-requests.js','public/stock-requests.css',
  'public/sales-stock-requests.html','public/scm-stock-requests.html','migrations/'+MIGRATION]
NEW_FILES={'migrations/'+MIGRATION}
IMAGE='mbbs-operator-app:special-scm-line-details-20261104'
ROLLBACK='mbbs-operator-app:special-scm-line-details-rollback-20261104'
TARGET_FILES=['test/mbt/integration/special-scm-line-details.test.js','test/mbt/unit/special-scm-line-details.browser.test.js',
  'test/mbt/unit/special-fulfillment-adapter.test.js']
EXPECTED_TARGET=19
REGRESSION=[f'test/mbt/{name}.test.js' for name in '''
integration/backorder-enhancements-browser integration/backorder-requests integration/backorder-review-flow-browser
integration/backorder-routing integration/sales-stock-check-popup integration/scm-line-visibility-browser
integration/special-approval-fulfillment integration/special-approval-browser integration/special-batch-browser
integration/special-batch-save integration/special-case-fields-browser integration/special-case-fields-http
integration/special-custom-po-http integration/special-customer-confirmation integration/special-delivery-method-change
integration/special-enhancements-http integration/special-header-note-markup integration/special-independent-po
integration/special-line-decline-browser integration/special-line-decline-http integration/special-manual-so-link
integration/special-planned-delivery-method integration/special-po-dispatch-stage integration/special-po-reference-only
integration/special-po-routing-browser integration/special-po-unsubmitted-link-http integration/special-po-warning
integration/special-readiness-status integration/special-request-enhancements integration/special-sales-request-corrections-browser
integration/special-scm-item-name integration/special-shared-orders integration/special-so-creation-confirmation
integration/special-stock-alert-browser integration/special-stock-check-editing-browser integration/special-stock-check-editing-http
integration/special-stock-request-workflow.red integration/special-stock-transfer integration/special-stock-updates-worker
integration/special-stock-updates integration/special-transfer-eta-browser integration/special-vendor-confirmation
integration/special-vendor-pickup-replacement integration/special-workflow-description-race integration/special-workflow-enquiry
integration/special-workflow-polish integration/special-workflow-pricing integration/special-workflow-review
integration/stock-request-so-refresh integration/scm-special-planned-card-browser
unit/special-case-fields-orders unit/special-confirmed-note unit/special-discount-summary unit/special-expiry-runtime
unit/special-header-note unit/special-local-pickup unit/special-planned-delivery-method unit/special-sales-internal-remark
unit/special-so-unitless-verification unit/special-stock-request-domain.red unit/special-stock-request-policy.red
unit/special-workflow-rest-orders unit/special-order-replacement.browser unit/special-manual-so-ui.browser
'''.split()]
LINT=[*TARGET_FILES,'src/special-stock-rest-orders.js','src/special-stock-fulfillment-adapter.js']
# The released patch must carry these, and nothing from other workspace work.
MARKERS={'src/special-stock-request-repository.js':'correctSpecialCaseVendor','src/special-stock-rest-orders.js':'allowSummaryLines',
  'src/special-stock-fulfillment-adapter.js':'allowSummaryLines:true','public/scm-special-stock-requests.js':'special-vendor-po-note',
  'public/sales-special-stock-requests.js':'SCM reply','public/stock-requests.css':'special-scm-reply',
  'public/sales-stock-requests.html':'lineDetails=20261104-v1','public/scm-stock-requests.html':'lineDetails=20261104-v1',
  'migrations/'+MIGRATION:'sales_visible_note_updated_at'}
UNRELATED=('aiChat','ai-chat','AiChat','autoRetry','adminRepost','ifir','IFIR')
for scope in (split,sor):scope.update(OUT=OUT)
split.update(PATCH=PATCH,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
# The proven validation harness reads these globals.
prev.update(OUT=OUT,FILES=FILES,TARGET_FILES=TARGET_FILES,REGRESSION=REGRESSION)
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

def make_patch():
    """Capture the live copy, then diff exactly the release files against the workspace."""
    sor['capture']()
    live,parts=OUT/'live-before',[]
    for name in FILES:
        old=live/name
        result=subprocess.run(['diff','-u','--label',f'a/server/{name}' if old.exists() else '/dev/null','--label',f'b/server/{name}',
          str(old) if old.exists() else '/dev/null',str(SERVER/name)],capture_output=True,text=True)
        assert result.returncode==1,(name,'unchanged' if result.returncode==0 else result.stderr)
        parts.append(f'diff --git a/server/{name} b/server/{name}\n'+result.stdout)
    PATCH.write_text(''.join(parts))
    print(json.dumps({'patch':str(PATCH),'files':len(FILES),'lines':sum(len(part.splitlines()) for part in parts)}))

def prepare():
    state=sor['capture']()
    live,candidate=OUT/'live-before',OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(live),str(candidate)],check=True)
    for name in NEW_FILES:assert not (live/name).exists(),name+' already live'
    with PATCH.open('rb') as patch:
        subprocess.run(['patch','-p2','--fuzz=0','--no-backup-if-mismatch','--batch','-d',str(candidate)],stdin=patch,check=True)
    differs=prev['changed_files'](live,candidate)
    assert differs==sorted(FILES),('Candidate must differ from live in exactly the release files',differs)
    diff=[]
    for name in FILES:
        old=str(live/name) if (live/name).exists() else '/dev/null'
        one=subprocess.run(['git','diff','--no-index','--',old,str(candidate/name)],capture_output=True,text=True).stdout
        added=[line for line in one.splitlines() if line.startswith('+') and not line.startswith('+++')]
        assert any(MARKERS[name] in line for line in added),name
        assert not any(word in line for line in added for word in UNRELATED),f'{name}: unrelated workspace work in candidate'
        diff.append(one)
    (OUT/'release.patch').write_text(''.join(diff))
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'patchSha256':sha(PATCH),'conflicts':[],
      'moduleBasis':{name:'live plus change.patch' for name in FILES},
      'sourceHashes':{name:sha(candidate/name) for name in FILES}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'patchLines':sum(len(d.splitlines()) for d in diff)}))

def lint(art):
    """ESLint the new tests and the changed adapter modules against the candidate sources."""
    tree=OUT/'candidate'
    mounts=[]
    for name in ('src','public','migrations'):mounts+=['-v',f'{tree}/{name}:/app/{name}:ro']
    result=subprocess.run(['docker','run','--rm','--network','none','--label','com.mbbs.lifecycle=disposable-test',
      '--cgroup-parent=mbbs-tests.slice','--init','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','256','--read-only',
      '--tmpfs','/tmp:size=128m',*mounts,'-v',f'{SERVER}/test:/app/test:ro','-w','/app',prev['TEST_IMAGE'],
      'node_modules/.bin/eslint','--config','eslint.mbt.config.js','--max-warnings=0',*LINT],capture_output=True,text=True,timeout=600)
    (art/'lint.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,('ESLint failed',(result.stdout+result.stderr)[-4000:])

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    prepared=base['ensure_sources']();art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    subprocess.run(['python3','docker/verify-memory-limits.py'],cwd=REPO,check=True,capture_output=True)
    tests={name:sha(SERVER/name) for name in [*TARGET_FILES,*REGRESSION]}
    lint(art)
    results=prev['suite'](art)
    live,cand=results['live'],results['candidate']
    pick=lambda tree,files,kind:sorted(f'{f} :: {n}' for f in files for n in tree.get(f,{}).get(kind,()))
    checks={
      'liveTarget':{'passed':len(pick(live,TARGET_FILES,'passed')),'failed':pick(live,TARGET_FILES,'failed')},
      'candidateTarget':{'passed':len(pick(cand,TARGET_FILES,'passed')),'failed':pick(cand,TARGET_FILES,'failed')},
      'live':{'passed':len(pick(live,REGRESSION,'passed')),'failed':len(pick(live,REGRESSION,'failed'))},
      'candidate':{'passed':len(pick(cand,REGRESSION,'passed')),'failed':len(pick(cand,REGRESSION,'failed'))},
      'missingFiles':sorted(f for f in [*TARGET_FILES,*REGRESSION] if f not in cand or f not in live),
      'newFailures':sorted(set(pick(cand,REGRESSION,'failed'))-set(pick(live,REGRESSION,'failed'))),
      'liveOnlyFailures':sorted(set(pick(live,REGRESSION,'failed'))-set(pick(cand,REGRESSION,'failed'))),
      'preexistingFailures':sorted(set(pick(cand,REGRESSION,'failed'))&set(pick(live,REGRESSION,'failed'))),
      'testHashes':tests}
    save(OUT/'validation-checks.json',checks)
    ok=(checks['candidateTarget']['passed']==EXPECTED_TARGET and not checks['candidateTarget']['failed'] and checks['liveTarget']['failed']
        and not checks['missingFiles'] and not checks['newFailures'] and checks['candidate']['passed']>=checks['live']['passed']>0)
    assert ok,('Validation failed',json.dumps({k:v for k,v in checks.items() if k!='testHashes'},indent=1)[-8000:])
    assert {name:sha(SERVER/name) for name in tests}==tests,'Tests changed during validation'
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    save(OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
      'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed','liveTargetFailed':len(checks['liveTarget']['failed']),
      'candidateTargetPassed':checks['candidateTarget']['passed'],'live':checks['live'],'candidate':checks['candidate'],
      'liveOnlyFailures':checks['liveOnlyFailures'],'preexistingFailures':len(checks['preexistingFailures'])}))

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; patch, prepare and validate again'
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    base['deploy']()
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n'
      +f'# Migration {MIGRATION} is additive; the previous image ignores its columns, so no schema rollback is needed.\n')

LIVE_CHECK=r'''
const repository = await import("/app/src/special-stock-request-repository.js");
const adapter = await import("/app/src/special-stock-fulfillment-adapter.js");
const record = { id: "10", entity: { id: "20" }, location: { id: "1" }, custbody3: { id: "1" }, custbody7: "", item: { items: [
  { line: 1, item: { id: "2055" }, quantity: 2, units: "1", rate: 10, description: "TEST material", location: { id: "1" } },
  { line: 2, item: { id: "-2" }, description: "Subtotal" }, { line: 3, item: { id: "2022" }, rate: -10, description: "10% discount" }] } };
const row = (uniquekey, rest_line_id, item) => ({ uniquekey, rest_line_id, item, status: "B", execution_quantity: 0, billed_quantity: 0, line_closed: "F" });
const boundary = { config: { pickupMethodId: "1", deliveryMethodId: "2" }, rest: async () => ({ data: structuredClone(record) }),
  queryAll: async () => [row(101, 1, 2055), row(102, 2, -2), row(103, 3, 2022)] };
const plan = await adapter.prepareSpecialFulfillmentPlan({ salesOrderId: 10, fulfillmentMethod: "mbt_delivery", deliveryAddress: "TEST site" }, boundary);
console.log(JSON.stringify({ summaryRows: plan.before.commercial.lines.map(line => line.itemId),
  saveStockChecks: typeof repository.saveSpecialStockChecks }));
process.exit(0);
'''

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    checks=[]
    for method,path,expected in [('POST','/api/scm/special-stock-requests/1/stock-check',401),('GET','/sales/stock-requests',200),('GET','/scm/stock-requests',200)]:
        code=int(subprocess.check_output(['curl','-sS','--max-time','15','-X',method,'-o','/dev/null','-w','%{http_code}',
          'http://127.0.0.1:3000'+path],text=True))
        assert code==expected,f'{path}: {code}'
        checks.append({'method':method,'path':path,'status':code})
    for asset,marker in [('/sales-special-stock-requests.js','special-scm-reply'),('/scm-special-stock-requests.js','special-vendor-po-note'),
        ('/stock-requests.css','special-scm-reply')]:
        body=subprocess.check_output(['curl','-fsS','--max-time','15','http://127.0.0.1:3000'+asset],text=True)
        assert marker in body,asset
    for page in ('/sales/stock-requests','/scm/stock-requests'):
        assert 'lineDetails=20261104-v1' in subprocess.check_output(['curl','-fsS','--max-time','15','http://127.0.0.1:3000'+page],text=True),page
    loaded=json.loads(base['docker']('exec','-i','-w','/app',APP,'node','--input-type=module',data=LIVE_CHECK.encode()).splitlines()[-1])
    assert loaded=={'summaryRows':[2055,-2,2022],'saveStockChecks':'function'},loaded
    db=base['db']
    assert db(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}';")==MIGRATION
    read="SET default_transaction_read_only=on; "
    assert db(read+"SELECT count(*) FROM information_schema.columns WHERE table_name='sales_special_stock_lines'"
      " AND column_name IN ('sales_visible_note_updated_at','sales_visible_note_updated_by');")=='2'
    flagged=db(read+"SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_source='manual_link'"
      " AND sales_order_netsuite_id IS NOT NULL AND line_edit_state ? 'orderReviewRequired';")
    assert flagged=='0',flagged
    cases=db(read+"SELECT string_agg(r.request_ref||':'||c.vendor_name||':'||COALESCE(c.fulfillment_change->>'status','none'),',' ORDER BY r.request_ref)"
      " FROM sales_special_stock_cases c JOIN sales_stock_requests r ON r.id=c.request_id WHERE r.request_ref IN ('SPREQ-000182','SPREQ-000185');")
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks,'modules':loaded,
      'manualLinkFlagsRemaining':0,'cases':cases})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks),'modules':loaded,'cases':cases}))
base['verify']=verify

if __name__=='__main__':
    {'patch':make_patch,'prepare':prepare,'validate':validate,'build':split['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()
