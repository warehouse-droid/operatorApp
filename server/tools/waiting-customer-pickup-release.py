#!/usr/bin/env python3
"""Release (2026-11-09): the Special Request stage "Waiting Customer Pickup" (migration 333) and the
operator delivery-list speedup. Both were written 2026-11-04/05 inside the never-deployed
special-pickup-performance release; its third part (Special list answers from saved statuses) went live
2026-11-06 as special-list-stall. This tool re-bases the other two parts on today's live code.

1. Waiting Customer Pickup (migration 333 + stage code). A Special request the customer only has to
   collect gets its own stage instead of a misleading one:
   * Pickup at the inquired yard once the linked PO is received (local receipt or PO drop-off, or a
     NetSuite Received/Billed status). SPREQ-000147 showed Waiting Vendor Confirmation with a billed PO.
   * Customer pickup at the vendor yard once the approved PO's SCM reference is Queued (or later), or
     the PO step was skipped. These showed Dispatch Arrangement, which has nothing to dispatch.
   Delivery keeps Dispatch Arrangement; backorders and completion rules are unchanged. Sales' "My
   special requests" alert counts the new stage; SCM labels it and hides "PO Sent to Vendor" there.
   Migration 333 adds the view special_stock_purchase_receipt and replaces special_stock_workflow_stages
   (last defined by 331; 334-339 do not touch it). No request or order data changes.
2. Operator delivery list (/api/delivery/notifications every 10 s per yard device, bootstrap and the
   order lists): open COs are read once per query (operator_co_candidates), split parents are found with
   one uncorrelated lookup, and only lines of orders the list can return are summarized. Measured
   read-only on production data 2026-11-05: active SO list 2.5 s -> 0.19 s, identical rows.

Not included: other sessions' unreleased work in the same files (conversation-message alerts in
special-stock-alerts.js / sales-special-alert.js, AI chat); the live broken-pallet code in
delivery-repository.js stays. The candidate is the live copy plus exactly the edits in
tools/release-edits/waiting-customer-pickup.json (each live text must occur once) plus the new
migration file, whose content is pinned by MIGRATION_SHA256.

Rollback: deploy() restores 331's stage view if the app is rolled back after the migration;
rollback-command.txt has the manual steps.

Steps: patch -> prepare -> quick (optional) -> validate -> build -> deploy (verifies) -> verify.
"""
import json,os,runpy,signal,subprocess,sys,time
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
prev=previous['prev']
split,sor,base=prev['split'],prev['sor'],prev['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/waiting-customer-pickup-20261109'
PATCH=OUT/'change.patch'
CODE_PATCH=Path(__file__).with_name('waiting-customer-pickup-release.code.patch')
EDITS=json.loads(Path(__file__).with_name('release-edits').joinpath('waiting-customer-pickup.json').read_text())
MIGRATION='333_special_waiting_customer_pickup.sql'
MIGRATION_SHA256='26e48c7aa676d325478c99d5d821d7d38b8b42ca65767e1b88e084eb2c00da07'
EDITED=sorted({name for name,_,_ in EDITS})
FILES=[*EDITED,'migrations/'+MIGRATION]
NEW_FILES={'migrations/'+MIGRATION}
IMAGE='mbbs-operator-app:waiting-customer-pickup-20261109'
ROLLBACK='mbbs-operator-app:waiting-customer-pickup-rollback-20261109'
TARGET_FILES=['test/mbt/unit/delivery-list-query-shape.test.js','test/mbt/unit/special-po-dispatch-stage.test.js',
  'test/mbt/integration/special-po-dispatch-stage.test.js','test/waiting-customer-pickup/waiting-customer-pickup-alerts.test.js',
  'test/waiting-customer-pickup/waiting-customer-pickup-alert.browser.test.js']
EXPECTED_TARGET=16
# Live must fail exactly these (the new behaviour) and nothing else in the target files (quick run 2026-11-09).
Q='test/mbt/unit/delivery-list-query-shape.test.js :: '
U='test/mbt/unit/special-po-dispatch-stage.test.js :: '
I='test/mbt/integration/special-po-dispatch-stage.test.js :: '
NEW_TESTS={Q+'/app/test/mbt/unit/delivery-list-query-shape.test.js',  # live lacks operatorCoCandidatesSql: the file cannot load
  U+'Special approval and deliberate PO skips keep their existing rules',
  U+'customer pickup at the vendor yard waits for the customer once the PO reference is queued',
  U+'pickup at the inquired yard waits for the customer once the PO is received, before any dispatch reference',
  I+'Special and Backorder wait for a PO reference with Queued, including accepted production ETAs',
  I+'customer pickups wait for the customer: vendor yard once the PO reference is queued, inquired yard once the PO is received',
  'test/waiting-customer-pickup/waiting-customer-pickup-alerts.test.js :: Sales alerts count requests waiting for customer pickup separately from Dispatch Arrangement',
  'test/waiting-customer-pickup/waiting-customer-pickup-alert.browser.test.js :: the Sales badge counts requests waiting for customer pickup and rejects totals that omit them'}
DELIVERY=[f'test/{name}.test.js' for name in '''
dispatch/integration/co-direct-to dispatch/integration/co-operator-routing dispatch/integration/co-supply-reference
dispatch/integration/control-local-only-reopen dispatch/integration/control-order-reopen-http dispatch/integration/dispatch-co-cargo-preservation
dispatch/integration/dispatch-co-cargo-repair dispatch/integration/historical-missing-order-snapshot dispatch/integration/local-reopen-workflows
mbt/integration/child-location-http mbt/integration/consolidation-load mbt/integration/group-underpack mbt/integration/link-to-fix
mbt/integration/linked-direct-ship-sync mbt/integration/local-vrma-final-qty mbt/integration/operator-background-http
mbt/integration/operator-delivery-reference mbt/integration/operator-group-draft mbt/integration/operator-linked-pcs-sales
mbt/integration/operator-netsuite-received-to mbt/integration/operator-reconciled-billed mbt/integration/operator-split-parent-visibility
mbt/integration/operator-to-yard-flow-reconciliation mbt/integration/operator-to-yard-flow mbt/integration/operator-yard-access
mbt/integration/sales-order-reattempt.red mbt/integration/transfer-order-background-posting mbt/integration/vrma-confirm-encoding
'''.split()]
STAGES=[f'test/mbt/{name}.test.js' for name in '''
integration/backorder-browser integration/backorder-requests integration/request-waiting-labels-browser integration/scm-special-planned-card-browser
integration/special-approval-browser integration/special-delivery-method-browser integration/special-delivery-method-change
integration/special-enhancements-browser integration/special-enhancements-http integration/special-handoff-notice-browser
integration/special-handoff-notice-query integration/special-planned-delivery-method integration/special-po-reference-browser
integration/special-sales-internal-remark-browser integration/special-stock-updates-browser integration/special-vendor-confirmation
integration/special-vendor-pickup-replacement integration/special-workflow-polish-http integration/special-workflow-polish
integration/stock-request-alert-list-browser integration/stock-request-alert-search-browser integration/special-stock-alert-http
integration/stock-request-alert-list-http integration/special-stock-alert-browser integration/special-scm-line-details
property/backorder-link-sequence.property property/special-vendor-confirmation.property unit/regular-stock-status
unit/special-approval-fulfillment unit/special-order-replacement.browser unit/special-planned-delivery-method
unit/special-scm-line-details.browser unit/special-supply-waiting unit/special-workflow-documents unit/special-workflow-polish
integration/special-stock-updates-http integration/special-po-reference-http
integration/special-request-enhancements integration/special-sales-alert-browser
unit/special-status-following integration/special-status-following
'''.split()]+['test/special-list-stall/special-list-stall.test.js','test/special-list-stall/special-list-stall-http.test.js']
REGRESSION=sorted(set(DELIVERY+STAGES)-set(TARGET_FILES))
LINT=['test/mbt/unit/delivery-list-query-shape.test.js','test/waiting-customer-pickup/waiting-customer-pickup-alerts.test.js',
  'test/waiting-customer-pickup/waiting-customer-pickup-alert.browser.test.js']
MARKERS={'src/delivery-repository.js':'operatorCoCandidatesSql()','src/operator-co-routing.js':'operator_co_candidates AS MATERIALIZED',
  'src/special-stock-request-repository.js':'purchase_order_received','src/special-stock-alerts.js':'waiting_customer_pickup',
  'public/special-stock-workflow.js':"waiting_customer_pickup: 'Waiting Customer Pickup'",'public/scm-special-stock-requests.js':'Waiting Customer Pickup',
  'public/special-stock-case-status.js':'waiting_customer_pickup','public/sales-special-alert.js':'waitingCustomerPickup',
  'public/stock-requests.css':'stock-request-pill.waiting_customer_pickup','public/sales-stock-requests.html':'pickupStage=20261109-v1',
  'public/scm-stock-requests.html':'pickupStage=20261109-v1','migrations/'+MIGRATION:"THEN 'waiting_customer_pickup'"}
UNRELATED=('aiChat','ai-chat','AiChat','newMessages','stock-conversation','unreadConversation','messageOnly','requestMessages',
  'client-error-reporter','autoRetry','adminRepost')
MAX_CHANGED_LINES=260
for scope in (split,sor):scope.update(OUT=OUT)
split.update(PATCH=PATCH,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
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

def rollback_schema():
    """The stage view live before this release (migration 331); the new receipt view is left unused."""
    text=(OUT/'live-before/migrations/331_special_vendor_pickup_completion.sql').read_text()
    stages=text[text.index('CREATE OR REPLACE VIEW special_stock_workflow_stages'):]
    assert "waiting_customer_pickup" not in stages and "THEN 'dispatch_arrangement'" in stages
    later=[p.name for p in (OUT/'live-before/migrations').glob('*.sql') if p.name[:3]>'331' and 'special_stock_workflow_stages' in p.read_text()]
    assert not later,('A later live migration redefines the stage view; rollback would undo it',later)
    return stages

def make_patch():
    """Capture live, apply exactly EDITS to a copy of each live file, add the pinned migration, store the patch."""
    sor['capture']()
    live,staged=OUT/'live-before',OUT/'patch-stage'
    subprocess.run(['rm','-rf','--',str(staged)],check=True)
    assert sha(SERVER/'migrations'/MIGRATION)==MIGRATION_SHA256,'Migration 333 changed in the workspace'
    texts={name:(live/name).read_text(encoding='utf-8') for name in EDITED}
    for name,old,new in EDITS:
        assert texts[name].count(old)==1,(name,'live text not found exactly once',old[:120])
        texts[name]=texts[name].replace(old,new)
    texts['migrations/'+MIGRATION]=(SERVER/'migrations'/MIGRATION).read_text(encoding='utf-8')
    parts=[]
    for name in FILES:
        target=staged/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(texts[name],encoding='utf-8')
        old=live/name
        assert old.exists()!=(name in NEW_FILES),(name,'new-file expectation does not match live')
        result=subprocess.run(['diff','-u','--label','/dev/null' if name in NEW_FILES else f'a/server/{name}','--label',f'b/server/{name}',
          str(old) if old.exists() else '/dev/null',str(target)],capture_output=True,text=True)
        assert result.returncode==1,(name,result.stderr)
        parts.append(f'diff --git a/server/{name} b/server/{name}\n'+result.stdout)
    subprocess.run(['rm','-rf','--',str(staged)],check=True)
    CODE_PATCH.write_text(''.join(parts));PATCH.write_bytes(CODE_PATCH.read_bytes())
    check=subprocess.run(['patch','-p2','--fuzz=0','--dry-run','--batch','-d',str(live)],stdin=PATCH.open('rb'),capture_output=True,text=True)
    assert check.returncode==0,('Patch does not apply to live',check.stdout[-3000:])
    print(json.dumps({'patch':str(PATCH),'files':len(FILES),'edits':len(EDITS)}))

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
    assert sha(candidate/'migrations'/MIGRATION)==MIGRATION_SHA256
    diff,changed=[],0
    for name in FILES:
        old=str(live/name) if (live/name).exists() else '/dev/null'
        one=subprocess.run(['git','diff','--no-index','--',old,str(candidate/name)],capture_output=True,text=True).stdout
        lines=[line for line in one.splitlines() if line[:1] in '+-' and line[:3] not in ('+++','---')]
        added=[line for line in lines if line.startswith('+')]
        assert any(MARKERS[name] in line for line in added),name
        assert not any(word in line for line in added for word in UNRELATED),f'{name}: unrelated work in candidate'
        changed+=len(lines);diff.append(one)
    assert changed<=MAX_CHANGED_LINES,('Release diff is larger than this change',changed)
    (OUT/'release.patch').write_text(''.join(diff))
    (OUT/'rollback-schema.sql').write_text(rollback_schema())
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'patchSha256':sha(PATCH),'conflicts':[],
      'moduleBasis':{name:'live plus change.patch' for name in FILES},
      'sourceHashes':{name:sha(candidate/name) for name in FILES}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'changedLines':changed}))

def lint(art):
    """Syntax-check the changed modules and ESLint the new tests against the candidate sources."""
    tree=OUT/'candidate'
    mounts=[]
    for name in ('src','public','migrations'):mounts+=['-v',f'{tree}/{name}:/app/{name}:ro']
    checks=' && '.join([*(f'node --check {name}' for name in [*FILES,*TARGET_FILES] if name.endswith('.js')),
      'node_modules/.bin/eslint --config eslint.mbt.config.js --max-warnings=0 '+' '.join(LINT)])
    result=subprocess.run(['docker','run','--rm','--network','none','--label','com.mbbs.lifecycle=disposable-test',
      '--cgroup-parent=mbbs-tests.slice','--init','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','256','--read-only',
      '--tmpfs','/tmp:size=128m',*mounts,'-v',f'{SERVER}/test:/app/test:ro','-w','/app',prev['TEST_IMAGE'],'sh','-c',checks],
      capture_output=True,text=True,timeout=600)
    (art/'lint.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,('Lint failed',(result.stdout+result.stderr)[-4000:])

def quick():
    """Target files only, live vs candidate (minutes): catches test bugs before the full validation."""
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'quick']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    extra=[name for name in os.environ.get('QUICK_EXTRA','').split() if name]
    prev.update(REGRESSION=extra)
    lint(art)
    results=prev['suite'](art)
    for label in ('live','candidate'):
        tree=results[label]
        print(label,json.dumps({f:{k:sorted(v) for k,v in tree.get(f,{}).items()} for f in [*TARGET_FILES,*extra]},indent=1))
        if label=='candidate' and any(tree.get(f,{}).get('failed') for f in [*TARGET_FILES,*extra]):
            print((art/f'{label}.log').read_text()[-8000:])

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    assert EXPECTED_TARGET and NEW_TESTS,'Set EXPECTED_TARGET and NEW_TESTS from a quick run first'
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
    ok=(checks['candidateTarget']['passed']==EXPECTED_TARGET and not checks['candidateTarget']['failed']
        and {f for f in checks['liveTarget']['failed'] if not f.endswith(' :: FILE EXIT')}==NEW_TESTS and not checks['missingFiles'] and not checks['newFailures']
        and checks['candidate']['passed']>=checks['live']['passed']>0)
    assert ok,('Validation failed',json.dumps({k:v for k,v in checks.items() if k!='testHashes'},indent=1)[-8000:])
    assert {name:sha(SERVER/name) for name in tests}==tests,'Tests changed during validation'
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    save(OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
      'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed','liveTargetFailed':checks['liveTarget']['failed'],
      'candidateTargetPassed':checks['candidateTarget']['passed'],'live':checks['live'],'candidate':checks['candidate'],
      'liveOnlyFailures':checks['liveOnlyFailures'],'preexistingFailures':checks['preexistingFailures']}))

def build():
    running=subprocess.run(['pgrep','-af',r'docker(-buildx)? (buildx )?build( |$)|compose .* build( |$)'],capture_output=True,text=True).stdout.strip()
    assert not running,('Another docker build is running; overlapping builds crashed dockerd on 2026-11-03',running)
    split['build']()

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; patch, prepare and validate again'
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    built=json.loads((OUT/'built.json').read_text())['imageId']
    try:
        base['deploy']()
    except BaseException:
        # The app was rolled back (or never switched): restore the stage view the previous image expects.
        audit=json.loads((OUT/'migration-audit.json').read_text()) if (OUT/'migration-audit.json').exists() else {}
        if audit.get('applied') and base['metadata'](APP)['imageId']!=built:
            base['db']("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"+(OUT/'rollback-schema.sql').read_text()+
              f"\nDELETE FROM schema_migrations WHERE filename='{MIGRATION}'; COMMIT;")
            save(OUT/'schema-rollback.json',{'restoredAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'views':['special_stock_workflow_stages']})
        raise
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n'
      +f'# then restore the stage view: psql < {OUT}/rollback-schema.sql and DELETE FROM schema_migrations WHERE filename=\'{MIGRATION}\'\n')

LIVE_CHECK=r'''
const workflow = await import("/app/public/special-stock-workflow.js");
const routing = await import("/app/src/operator-co-routing.js");
const yard = { salesOrderId: 1, purchaseOrderId: 2, purchaseOrderApproved: true, fulfillmentMethod: "yard_pickup", purchaseOrderReceived: true };
const vendor = { salesOrderId: 1, purchaseOrderId: 2, purchaseOrderApproved: true, fulfillmentMethod: "vendor_pickup", purchaseOrderReference: "REF", purchaseOrderDispatchStatus: "Queued" };
const delivery = { ...vendor, fulfillmentMethod: "mbt_delivery" };
console.log(JSON.stringify({ yardReceived: workflow.specialStage(yard), vendorQueued: workflow.specialStage(vendor), delivery: workflow.specialStage(delivery),
  label: workflow.SPECIAL_STAGES.waiting_customer_pickup, candidates: routing.operatorCoCandidatesSql().includes("MATERIALIZED") }));
process.exit(0);
'''

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    checks=[]
    for method,path,expected in [('GET','/api/delivery/notifications?locationId=1',401),('GET','/api/sales/special-stock-requests/alerts',401),
        ('GET','/sales/stock-requests',200),('GET','/scm/stock-requests',200)]:
        code=int(subprocess.check_output(['curl','-sS','--max-time','15','-X',method,'-o','/dev/null','-w','%{http_code}',
          'http://127.0.0.1:3000'+path],text=True))
        assert code==expected,f'{path}: {code}'
        checks.append({'method':method,'path':path,'status':code})
    for asset,marker in [('/scm-special-stock-requests.js','Waiting Customer Pickup'),('/special-stock-workflow.js','waiting_customer_pickup'),
        ('/sales-special-alert.js','waitingCustomerPickup'),('/stock-requests.css','waiting_customer_pickup'),
        ('/sales/stock-requests','pickupStage=20261109-v1'),('/scm/stock-requests','pickupStage=20261109-v1')]:
        body=subprocess.check_output(['curl','-fsS','--max-time','15','http://127.0.0.1:3000'+asset],text=True)
        assert marker in body,asset
    loaded=json.loads(base['docker']('exec','-i','-w','/app',APP,'node','--input-type=module',data=LIVE_CHECK.encode()).splitlines()[-1])
    assert loaded=={'yardReceived':'waiting_customer_pickup','vendorQueued':'waiting_customer_pickup','delivery':'dispatch_arrangement',
      'label':'Waiting Customer Pickup','candidates':True},loaded
    db=base['db']
    assert db(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}';")==MIGRATION
    read="SET default_transaction_read_only=on; "
    assert db(read+"SELECT to_regclass('public.special_stock_purchase_receipt');")=='special_stock_purchase_receipt'
    assert 'waiting_customer_pickup' in db(read+"SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass);")
    stages=db(read+"SELECT string_agg(stage||'='||n,',' ORDER BY stage) FROM (SELECT stage,count(*) n FROM special_stock_workflow_stages GROUP BY stage) s;")
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks,'modules':loaded,'stageCounts':stages})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks),'modules':loaded,'stageCounts':stages}))
base['verify']=verify

if __name__=='__main__':
    {'patch':make_patch,'prepare':prepare,'quick':quick,'validate':validate,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()
