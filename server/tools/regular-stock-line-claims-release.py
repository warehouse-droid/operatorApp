#!/usr/bin/env python3
"""Release per-SO-line Delivery claims (migration 329) over the live app.

Steps: prepare -> validate -> build -> deploy (applies 329, swaps the app, verifies; rolls the app back on
failure) -> verify. Each file is a three-way merge of this change (HEAD -> workspace) onto the captured live
copy, so unrelated workspace work is never released. Migration 329 is compatible with the previous image:
it only drops the SO-level unique indexes and adds nullable claim columns, so an app rollback needs no
schema rollback.
"""
import difflib,json,os,re,runpy,signal,subprocess,sys,urllib.error,urllib.request
from pathlib import Path

base=runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope=base['prepare'].__globals__
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/regular-stock-line-claims-20261102'
MIGRATION='329_regular_stock_so_line_claims.sql'
NEW=['src/regular-stock-line-claim-domain.js','src/regular-stock-line-claims.js','migrations/'+MIGRATION]
FILES=[*NEW,'src/regular-stock-delivery.js','src/regular-stock-handoff.js','public/regular-stock-delivery.js','public/sales-stock-requests.html']
SCRIPT_URL='/regular-stock-delivery.js?unified=20261019&v=20261102-line-claims'
TESTS=['test/mbt/unit/regular-stock-line-claim-domain.test.js','test/mbt/unit/regular-stock-delivery-selection.test.js',
  'test/mbt/unit/regular-stock-delivery-simple.test.js','test/mbt/integration/regular-stock-delivery-line-claims.test.js',
  'test/mbt/integration/regular-stock-delivery-simple.test.js','test/mbt/integration/regular-stock-target-yard-access.test.js',
  'test/mbt/integration/regular-stock-delivery-conversions.test.js','test/mbt/integration/regular-stock-delivery-progress.test.js',
  'test/mbt/integration/regular-stock-delivery-simple-http.test.js','test/mbt/integration/regular-stock-controls.test.js',
  'test/mbt/integration/regular-stock-so-scope.test.js','test/mbt/integration/stocking-backorder-conversion.test.js',
  'test/mbt/integration/scm-stock-actions-http.test.js','test/mbt/integration/regular-stock-pickup.test.js',
  'test/mbt/integration/regular-stock-request.test.js','test/mbt/integration/regular-stock-delivery-selection-browser.test.js',
  'test/mbt/infrastructure/legacy-public-syntax.test.js']
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:regular-stock-line-claims-20261102',
  ROLLBACK='mbbs-operator-app:regular-stock-line-claims-rollback-20261102')

def services(): return {key:base['metadata'](name) for key,name in base['SERVICES'].items()}

def capture():
    OUT.mkdir(parents=True,exist_ok=True)
    state=services()
    if (OUT/'capture.json').exists():
        assert json.loads((OUT/'capture.json').read_text())==state,'Live changed since capture; move live-before aside and prepare again'
        return state
    before=OUT/'live-before';before.mkdir(exist_ok=True)
    for name in ['src','public','migrations']:
        subprocess.run(['sudo','-n','docker','cp',APP+':/app/'+name,str(before/name)],check=True)
    subprocess.run(['sudo','-n','chown','-R',f'{os.getuid()}:{os.getgid()}',str(before)],check=True)
    assert state==services(),'Live changed while capturing'
    base['save'](OUT/'capture.json',state)
    return state

def prepare():
    state=capture();live_dir=OUT/'live-before'
    assert not [p.name for p in (live_dir/'migrations').glob('329_*')],'Live already has a 329 migration; renumber first'
    applied=base['db']("SET default_transaction_read_only=on; SELECT filename FROM schema_migrations WHERE filename LIKE '329\\_%';")
    assert not applied,'Production already recorded a 329 migration: '+applied
    out={};conflicts=[];liveMatchesHead={}
    for name in FILES:
        live=(live_dir/name).read_bytes() if (live_dir/name).exists() else b''
        if name in NEW: assert not live,'Live unexpectedly has '+name
        head=base['gitfile']('HEAD',name)
        liveMatchesHead[name]=live==head
        merged=base['merge'](live,head,(SERVER/name).read_bytes(),name,'line-claims')
        if b'<<<<<<< ' in merged:conflicts.append(name)
        out[name]=merged
    candidate=OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(live_dir),str(candidate)],check=True)
    patch=[]
    for name in FILES:
        (candidate/name).write_bytes(out[name])
        live=(live_dir/name).read_text(encoding='utf-8') if (live_dir/name).exists() else ''
        patch.extend(difflib.unified_diff(live.splitlines(True),out[name].decode().splitlines(True),fromfile='live/'+name,tofile='candidate/'+name))
    (OUT/'release.patch').write_text(''.join(patch),encoding='utf-8')
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    prepared={'baseImage':state['app']['imageRef'],'conflicts':conflicts,
      'sourceHashes':{name:base['sha'](candidate/name) for name in FILES},
      'sameAsWorkspace':{name:out[name]==(SERVER/name).read_bytes() for name in FILES},'liveMatchesHead':liveMatchesHead}
    base['save'](OUT/'prepared.json',prepared)
    print(json.dumps({k:prepared[k] for k in ['baseImage','conflicts','sameAsWorkspace','liveMatchesHead']}))

def tap(text):
    rows=[(s,n) for s,n in re.findall(r'^(not ok|ok) \d+ - (.+)$',text,re.M) if ' # SKIP' not in n]
    return {'passed':sorted(n for s,n in rows if s=='ok'),'failed':sorted(n for s,n in rows if s=='not ok')}

def suite(source,files,art,label):
    """One isolated, bounded Compose project with the given app source; torn down even on failure."""
    project=f'mbbs-line-claims-{label}-{os.getpid()}'
    override=art/f'compose-{label}.json'
    mounts=lambda names:[{'type':'bind','source':str(source/n),'target':'/app/'+n,'read_only':True} for n in names]
    artifact={'type':'bind','source':str(art),'target':'/app/test-artifacts'}
    label_disposable={'com.mbbs.lifecycle':'disposable-test'}
    override.write_text(json.dumps({'services':{
      'migrate':{'volumes':[*mounts(['src','migrations']),artifact],'labels':label_disposable},
      'e2e':{'volumes':[*mounts(['src','public','migrations']),artifact],'labels':label_disposable},
      'db':{'labels':label_disposable}}}))
    compose=['docker','compose','-p',project,'-f',str(REPO/'docker-compose.mbt-test.yml'),'-f',str(override),'--profile','e2e','--profile','runtime']
    def step(*args):
        result=subprocess.run([*compose,*args],capture_output=True,text=True)
        assert result.returncode==0,(args,(result.stdout+result.stderr)[-3000:])
    try:
        step('build','migrate','e2e');step('up','-d','--wait','db');step('run','--rm','--no-deps','-T','migrate')
        result=subprocess.run([*compose,'run','--rm','--no-deps','-T','e2e','node','--test','--test-concurrency=1',*files],
          capture_output=True,text=True,timeout=3600)
        (art/f'{label}.tap').write_text(result.stdout+result.stderr)
        return result.returncode,tap(result.stdout)
    finally:
        subprocess.run([*compose,'down','--volumes','--remove-orphans'],capture_output=True)
        for kind in ['ps','volume','network']:
            args=['docker',kind,*(['-a'] if kind=='ps' else ['ls']),'-q','--filter',f'label=com.docker.compose.project={project}']
            assert not subprocess.check_output(args,text=True).strip(),f'{project} {kind} remains after teardown'

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    prepared=base['ensure_sources']();art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    subprocess.run(['python3','docker/verify-memory-limits.py'],cwd=REPO,check=True,capture_output=True)
    code,candidate=suite(OUT/'candidate',TESTS,art,'candidate')
    checks={'candidate':{'passed':len(candidate['passed']),'failed':candidate['failed']}}
    # Every test must pass on the exact candidate; any failure stops the release for review.
    assert code==0 and not candidate['failed'],('Candidate tests failed',checks,(art/'candidate.tap').read_text()[-4000:])
    assert len(candidate['passed'])>=140,('Too few tests ran',checks)
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    # Bind the result to the live image it was tested on; a newer live release requires a fresh prepare and validate.
    base['save'](OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],
      'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed',**checks}))

def apply_migration():
    if base['db']("SELECT filename FROM schema_migrations WHERE filename='"+MIGRATION+"';"):
        return {'filename':MIGRATION,'alreadyApplied':True}
    sql=(OUT/'candidate/migrations'/MIGRATION).read_text()
    before=base['db']("SELECT count(*) FROM regular_stock_so_line_owners;")
    base['db']("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"+sql+
      "\nINSERT INTO schema_migrations(filename) VALUES ('"+MIGRATION+"'); COMMIT;")
    after=base['db']("SELECT count(*)||','||count(item_id) FROM regular_stock_so_line_owners;").split(',')
    assert after[0]==before,'Claim rows changed during migration'
    return {'filename':MIGRATION,'applied':True,'sha256':base['sha'](OUT/'candidate/migrations'/MIGRATION),
      'claimRows':int(after[0]),'claimRowsWithItem':int(after[1]),'appRollbackNeedsSchemaRollback':False}
scope['apply_migration']=apply_migration

def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20) as response:
            return response.status,response.read()
    except urllib.error.HTTPError as error:
        return error.code,error.read()

# Read-only check of every active claim in production through the released code; reports counts only.
CLAIM_SURVEY='''
const {query,withTransaction,closeDb}=await import('/app/src/db.js');
const {loadSalesOrderLineClaims}=await import('/app/src/regular-stock-line-claims.js');
try{
  const summary=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const orders=(await query('SELECT DISTINCT sales_order_id FROM regular_stock_so_line_owners WHERE released_at IS NULL')).rows;
    const reasons={};let claims=0;
    for(const row of orders)for(const claim of await loadSalesOrderLineClaims(Number(row.sales_order_id))){claims++;reasons[claim.reason]=(reasons[claim.reason]||0)+1;}
    return {salesOrders:orders.length,activeClaims:claims,byReason:reasons};
  });
  console.log(JSON.stringify(summary));
}finally{await closeDb();}
'''

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    db=lambda sql:base['db']('SET default_transaction_read_only=on; '+sql)
    assert db("SELECT filename FROM schema_migrations WHERE filename='"+MIGRATION+"';")==MIGRATION
    assert db("SELECT to_regclass('public.regular_stock_so_line_owners_active') IS NOT NULL;")=='t'
    assert db("SELECT count(*) FROM pg_indexes WHERE indexname IN ('regular_stock_handoffs_sales_order_unique','regular_stock_handoffs_sales_ref_unique');")=='0'
    checks=[]
    status,body=get('http://127.0.0.1:3000/sales/stock-requests');assert status==200 and SCRIPT_URL.encode() in body,status
    checks.append({'path':'/sales/stock-requests','status':status})
    status,body=get('http://127.0.0.1:3000'+SCRIPT_URL);assert status==200 and body==(OUT/'candidate/public/regular-stock-delivery.js').read_bytes()
    checks.append({'path':SCRIPT_URL,'status':status})
    status,_=get('http://127.0.0.1:3000/api/sales/stock-requests/delivery/operations/active');assert status in (401,403),status
    checks.append({'path':'/api/sales/stock-requests/delivery/operations/active','status':status})
    survey=json.loads(base['docker']('exec','-i',APP,'node','--input-type=module','-',data=CLAIM_SURVEY.encode()).splitlines()[-1])
    base['save'](OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'migrationVerified':True,'http':checks,'claimSurvey':survey})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks),'claimSurvey':survey}))
scope['verify']=verify

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; prepare and validate again'
    read=lambda sql:base['db']('SET default_transaction_read_only=on; '+sql)
    assert read("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")=='0',\
        'A NetSuite posting is running; retry deployment after it finishes'
    assert read("SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running');")=='0',\
        'A Delivery request is being processed; retry deployment after it finishes'
    base['deploy']()
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n')

if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':base['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()
