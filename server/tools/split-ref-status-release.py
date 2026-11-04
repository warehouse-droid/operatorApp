#!/usr/bin/env python3
"""Release the PO Split reference and status fixes over the live app.

1. A Packing Slip / Ref saved on a split row (PO/TO Schedule, or the PO ref endpoint) now moves the
   split header ref with the child PO's visible ref, so PO Split can still open the split instead of
   failing with "SCM split <ref> was not found."
2. Renames drop the stale SCM PO catalog card under the old ref.
3. Order-list status (SCM PO mutation responses, catalog refresh, Dispatch orders) keeps an actively
   planned split Planned over its family's reconciliation Hold, matching PO Split detail and PO/TO
   Schedule (the card no longer says Hold while Status says Planned).

The candidate is the live copy plus deployments/split-ref-status-20261103/change.patch (only this
change, strict context, no fuzz); unrelated workspace edits are never released. No migration.

Steps: prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
Validation reuses the existing test image with sources mounted (no image build), in a bounded,
labelled, always-torn-down network: live must fail the two new tests, the candidate must pass them,
and the candidate must add no failure to the related suites.
"""
import collections,json,os,re,runpy,signal,subprocess,sys,time
from pathlib import Path

release=runpy.run_path(str(Path(__file__).with_name('sor-in-outbound-release.py')))
sor=release['prepare'].__globals__
base=sor['scope']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/split-ref-status-20261103'
PATCH=OUT/'change.patch'
FILES=['src/dispatch-repository.js','src/scm-reconciliation-repository.js','src/server.js']
IMAGE='mbbs-operator-app:split-ref-status-20261103'
ROLLBACK='mbbs-operator-app:split-ref-status-rollback-20261103'
TEST_IMAGE='mbbs-mbt-p1-test-test:latest'
TARGET_FILES=['test/mbt/integration/scm-po-split-ref-reuse.test.js',
  'test/dispatch/integration/scm-po-split-status-consistency.red.test.js']
TARGET_PATTERN="packing-slip ref saved on a split row|order-list status keeps an actively planned split"
REGRESSION=[*TARGET_FILES,
  'test/dispatch/integration/scm-manual-split-authority.red.test.js',
  'test/dispatch/integration/scm-schedule-split-parity.test.js',
  'test/dispatch/integration/scm-po-split-editing.test.js',
  'test/dispatch/integration/direct-linked-po-lifecycle.test.js',
  'test/dispatch/integration/direct-linked-po-group-lifecycle.test.js',
  'test/dispatch/integration/scm-direct-ship-schedule.test.js',
  'test/dispatch/integration/scm-search-vendor-completion.test.js',
  'test/dispatch/integration/dispatch-po-ref-projection-consistency.red.test.js',
  'test/dispatch/integration/order-update-writers.test.js',
  'test/mbt/integration/scm-schedule-status-concurrency.test.js',
  'test/mbt/integration/special-po-reference-http.test.js',
  'test/mbt/integration/special-po-dispatch-stage.test.js']
sor.update(OUT=OUT,__file__=str(Path(__file__).resolve()))
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
save,sha=base['save'],base['sha']

def prepare():
    state=sor['capture']()
    live,candidate=OUT/'live-before',OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(live),str(candidate)],check=True)
    with PATCH.open('rb') as patch:
        subprocess.run(['patch','-p2','--fuzz=0','--no-backup-if-mismatch','--batch','-d',str(candidate)],stdin=patch,check=True)
    differs=subprocess.run(['diff','-rq',str(live),str(candidate)],capture_output=True,text=True).stdout.splitlines()
    assert len(differs)==len(FILES) and all(any(name in line for name in FILES) for line in differs),differs
    diff=[]
    for name in FILES:
        diff+=subprocess.run(['git','diff','--no-index','--',str(live/name),str(candidate/name)],capture_output=True,text=True).stdout.splitlines(True)
    added=[line for line in diff if line.startswith('+') and not line.startswith('+++')]
    assert any('removeRenamedScmPurchaseOrderCatalogOrder' in line for line in added)
    assert any('activelyPlannedSplitRefs' in line for line in added)
    assert any('splitRefChanges' in line for line in added)
    assert not any(re.search(r'aiChat|recentDays',line) for line in added),'unrelated workspace work in candidate'
    (OUT/'release.patch').write_text(''.join(diff))
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'patchSha256':sha(PATCH),'conflicts':[],
      'moduleBasis':{name:'live plus change.patch' for name in FILES},
      'sourceHashes':{name:sha(candidate/name) for name in FILES}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'patchLines':len(diff)}))

def tap(text):
    rows=re.findall(r'^(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO).*)?$',text,re.M)
    return {'passed':collections.Counter(n for s,n,k in rows if s=='ok' and not k),
            'failed':collections.Counter(n for s,n,k in rows if s=='not ok' and not k)}

def suite(art):
    tag=f'mbbs-split-ref-status-{os.getpid()}'
    net,db=tag+'-net',tag+'-db'
    labels=['--label','com.mbbs.lifecycle=disposable-test','--label','com.mbbs.harness='+tag]
    def docker(*args,**kw):return subprocess.run(['docker',*args],capture_output=True,text=True,**kw)
    def node(tree,*command,timeout=3600,database='mbt_test'):
        name=f'{tag}-run-{os.urandom(3).hex()}'
        return docker('run','--rm','--name',name,'--network',net,*labels,'--cgroup-parent=mbbs-tests.slice','--init',
          '--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','256','--read-only',
          '--tmpfs','/app/data:uid=1000,gid=1000,mode=0700,size=64m','--tmpfs','/tmp:uid=1000,gid=1000,mode=1777,size=256m',
          '-v',f'{tree}/src:/app/src:ro','-v',f'{OUT}/live-before/migrations:/app/migrations:ro',
          '-v',f'{SERVER}/test:/app/test:ro','-v',f'{art}:/app/test-artifacts',
          '-e','NODE_ENV=test','-e','MBT_TEST_ISOLATED=1','-e','MBBS_ENV_FILE=.env.mbt-test-does-not-exist',
          '-e','XDG_CONFIG_HOME=/tmp/cfg','-e','XDG_CACHE_HOME=/tmp/cache',
          '-e',f'DATABASE_URL=postgres://mbt_test:mbt_test_password@{db}:5432/{database}',
          '-e','MBT_NETSUITE_WRITES_ENABLED=false','-e','NETSUITE_DIRECT_ACCESS_ENABLED=false',
          '-e','NETSUITE_MIRROR_ROLE=disabled','-e','SAMSARA_WRITES_ENABLED=false',
          '-e','SMART_SCM_LIVE_EXECUTION_ENABLED=false','-e','SALES_PUBLIC_ACCESS_ENABLED=false',
          '-e','DISPATCH_PLANNER_ORDER_POOL_MODE=off','-e','DISPATCH_PLANNER_COMMAND_MODE=off',
          '-e','OLLAMA_BASE_URL=http://127.0.0.1:9',TEST_IMAGE,*command,timeout=timeout)
    results={}
    try:
        assert docker('network','create','--internal',*labels,net).returncode==0
        started=docker('run','-d','--rm','--name',db,'--network',net,*labels,'--cgroup-parent=mbbs-tests.slice','--init',
          '--cpus','1','--memory','768m','--memory-swap','768m','--pids-limit','256',
          '--tmpfs','/var/lib/postgresql:size=768m','-e','POSTGRES_DB=mbt_test','-e','POSTGRES_USER=mbt_test',
          '-e','POSTGRES_PASSWORD=mbt_test_password','-e','PGDATA=/var/lib/postgresql/data',
          'postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15')
        assert started.returncode==0,started.stderr
        for _ in range(60):
            if docker('exec',db,'pg_isready','-U','mbt_test','-d','mbt_test').returncode==0:break
            time.sleep(1)
        for name in FILES:
            for tree in [OUT/'live-before',OUT/'candidate']:
                check=node(tree,'node','--check','src/'+name.removeprefix('src/'))
                assert check.returncode==0,(tree,name,check.stderr[-2000:])
        for label,tree in [('live',OUT/'live-before'),('candidate',OUT/'candidate')]:
            # Each tree and run gets a fresh database: suites reuse fixed refs across runs.
            for run in ['target','regression']:
                database=f'mbt_{label}_{run}'
                created=docker('exec',db,'createdb','-U','mbt_test',database)
                assert created.returncode==0,created.stderr
                migrate=node(tree,'npm','run','--silent','migrate',database=database)
                (art/f'migrate-{database}.log').write_text(migrate.stdout+migrate.stderr)
                assert migrate.returncode==0,(migrate.stdout+migrate.stderr)[-3000:]
            target=node(tree,'node','--test','--test-reporter=tap','--test-concurrency=1','--test-name-pattern',TARGET_PATTERN,*TARGET_FILES,database=f'mbt_{label}_target')
            regression=node(tree,'node','--test','--test-reporter=tap','--test-concurrency=1',*REGRESSION,database=f'mbt_{label}_regression')
            (art/f'{label}-target.tap').write_text(target.stdout+target.stderr)
            (art/f'{label}-regression.tap').write_text(regression.stdout+regression.stderr)
            results[label]={'target':tap(target.stdout),'regression':tap(regression.stdout)}
        return results
    finally:
        ids=docker('ps','-aq','--filter','label=com.mbbs.harness='+tag).stdout.split()
        if ids:docker('rm','-f','-v',*ids)
        docker('network','rm',net)
        assert not docker('ps','-aq','--filter','label=com.mbbs.harness='+tag).stdout.strip(),tag+' containers remain'
        assert docker('network','inspect',net).returncode!=0,tag+' network remains'

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    prepared=base['ensure_sources']();art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    subprocess.run(['python3','docker/verify-memory-limits.py'],cwd=REPO,check=True,capture_output=True)
    tests={name:sha(SERVER/name) for name in REGRESSION}
    results=suite(art)
    live,cand=results['live'],results['candidate']
    total=lambda counter:sum(counter.values())
    checks={
      'liveTarget':{'passed':total(live['target']['passed']),'failed':sorted(live['target']['failed'])},
      'candidateTarget':{'passed':sorted(cand['target']['passed']),'failed':sorted(cand['target']['failed'])},
      'live':{'passed':total(live['regression']['passed']),'failed':total(live['regression']['failed'])},
      'candidate':{'passed':total(cand['regression']['passed']),'failed':total(cand['regression']['failed'])},
      'newFailures':sorted(n for n,c in cand['regression']['failed'].items() if c>live['regression']['failed'].get(n,0)),
      'preexistingFailures':sorted(n for n in cand['regression']['failed'] if live['regression']['failed'].get(n)),
      'testHashes':tests}
    save(OUT/'validation-checks.json',checks)
    live_total=checks['live']['passed']+checks['live']['failed'];cand_total=checks['candidate']['passed']+checks['candidate']['failed']
    ok=(len(checks['candidateTarget']['passed'])==2 and not checks['candidateTarget']['failed']
        and len(checks['liveTarget']['failed'])==2 and not checks['newFailures'] and cand_total==live_total>0)
    assert ok,('Validation failed',json.dumps(checks,indent=1)[-6000:])
    assert {name:sha(SERVER/name) for name in REGRESSION}==tests,'Tests changed during validation'
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    save(OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
      'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed','liveTargetFailed':len(checks['liveTarget']['failed']),
      'candidateTargetPassed':len(checks['candidateTarget']['passed']),'live':checks['live'],'candidate':checks['candidate'],
      'preexistingFailures':len(checks['preexistingFailures'])}))

def build():
    # Overlapping BuildKit builds crashed dockerd on this host (2026-11-03); never build alongside another.
    others=subprocess.run(['pgrep','-af',r'docker(-buildx)? (buildx )?build|compose .* build'],capture_output=True,text=True).stdout
    others=[line for line in others.splitlines() if 'pgrep' not in line and 'prune' not in line]
    assert not others,('Another image build is running; retry when it finishes',others)
    base['build']()

LIVE_STATUS_CHECK=r'''
const { pool, query } = await import("/app/src/db.js");
pool.on("connect", (client) => { client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").catch(() => process.exit(3)); });
const ro = await query("SHOW default_transaction_read_only");
if (ro.rows[0].default_transaction_read_only !== "on" || pool.totalCount !== 1) process.exit(2);
const { listScmPurchaseOrders } = await import("/app/src/dispatch-repository.js");
const { enrichScmScheduleWithReconciliation } = await import("/app/src/scm-reconciliation-repository.js");
const planned = await query(`SELECT split.split_po_ref AS ref
  FROM dispatch_scm_po_splits split
  JOIN scm_transport_schedule s ON s.order_kind = 'PO' AND lower(s.order_ref) = lower(split.split_po_ref)
  JOIN dispatch_plan_order_assignments a ON lower(a.order_ref) = lower(split.split_po_ref)
  JOIN dispatch_plans p ON p.id = a.plan_id AND p.status <> 'cancelled'
 WHERE split.status = 'active' AND s.status = 'Planned' ORDER BY split.updated_at DESC LIMIT 5`);
const out = [];
for (const { ref } of planned.rows) {
  const order = (await listScmPurchaseOrders({ search: ref, includeAllDiscoverable: true })).find((o) => o.id === ref);
  if (!order) continue;
  const [row] = await enrichScmScheduleWithReconciliation([{ orderKind: "PO", orderRef: order.id,
    sourceRef: order.sourcePoRef || order.originalPoRef || order.id, sourceId: order.netsuiteId || null,
    isScmSplit: order.isScmSplit === true, status: order.scm?.status || "Hold",
    scheduleId: order.scm?.scheduleId || null, updatedAt: order.scm?.updatedAt || null }], { includeDetails: false, view: "dispatch" });
  out.push({ ref, status: row.calculatedStatus || row.reconciliationApplicationStatus || row.status });
}
console.log(JSON.stringify(out));
process.exit(0);
'''

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    checks=[]
    for path in ['/api/dispatch/scm/v2/purchase-orders','/api/dispatch/scm/purchase-order-splits/x/source-lines','/api/scm/schedule']:
        code=int(subprocess.check_output(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:3000'+path],text=True))
        assert code==401,f'{path}: {code}'
        checks.append({'path':path,'status':code})
    statuses=json.loads(base['docker']('exec','-i','-w','/app',APP,'node','--input-type=module',data=LIVE_STATUS_CHECK.encode()).splitlines()[-1])
    # The defect: a family Hold overrode an actively planned split in order lists.
    assert not any(row['status']=='Hold' for row in statuses),('Planned splits still list Hold',statuses)
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks,'plannedSplitListStatus':statuses})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks),'plannedSplitsChecked':len(statuses)}))
base['verify']=verify

if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':build,'deploy':sor['deploy'],'verify':verify}[sys.argv[1]]()
