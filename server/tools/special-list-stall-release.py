#!/usr/bin/env python3
"""Release: the Special Request list no longer stalls when the app is busy or NetSuite is slow, a
status refresh that changed nothing no longer makes every open page reload, and an exhausted
database connection pool is visible in Admin -> Audit Log.

2026-11-06 21:05-21:23 UTC: the SCM Special Request list took up to 105 s (normally 0.5-3 s) and
several loads were abandoned, while other pages queued too (Operator notifications up to 86 s,
current draft 46 s, a pickup confirm 86 s). Read-only findings:
  * The app process used node-postgres' default pool of 10 connections, all 10 busy. A transfer
    posting job (2.5 min), a return batch (1 min) and the operator push check (45 s) each held a
    connection "idle in transaction" while every other request waited for one.
  * Alert polling tripled between 21:10 and 21:20 (PO-reference, delivery-method, conversation and
    stock-request alerts: 4,100-5,200 requests per 5 minutes against ~2,000 at 20:50).
  * Every Special list load read the list (60 rows = 1.7 MB), asked NetSuite for every SO/PO status
    older than 5 minutes, saved each one in its own transaction (90 in the minute after 21:12), and
    read the list again before answering, so it needed the most connections in a row and waited the
    longest. Saving bumped synced_at even when the status was unchanged, which counted as an update,
    wrote an audit row and a mirror event, and broadcast special-stock-request.updated, on which
    every open Sales/SCM/Dispatch tab re-fetches its alert badges and the list.
  * POB04206's PO 1087313 was deleted in NetSuite, so it was stale forever: every list load asked
    NetSuite for it again and logged "Special order status response is missing or invalid".
NetSuite itself answered in 0.5-1.6 s when measured afterwards; the list query took 0.5-4.4 s.

Changes (live copy plus exactly EDITS):
  src/special-stock-status-refresh.js
    * persistSpecialOrderStatusObservation reports a change only when status/status_text changed;
      an unchanged status renews synced_at (the fence) without audit row, mirror event or reload.
    * createBackgroundSpecialStatusRefresh: one background batch at a time; a load during a running
      batch joins it; onUpdated runs only when a status changed; failures are logged, never thrown.
    * An order NetSuite did not answer for (missing/deleted, malformed, failed call) is not asked
      again for 5 minutes unless forced (Refresh SO, nightly vendor-pickup refresh still force).
  src/server.js  The Sales and SCM Special list endpoints answer from saved statuses and refresh in
    the background (written 2026-11-05 in tools/release-edits/special-list-background-status.json,
    never released). Case detail and the explicit Refresh SO stay synchronous.
  src/db.js  App pool: 30 connections (DATABASE_POOL_MAX, 1-50) instead of the default 10.
    PostgreSQL allows 100; ~22 were in use (worst case after: app 30 + worker 10 + monitors 3).
  src/system-resource-monitor.js  Each 30 s sample stores the app pool's size, idle count and peak
    queue (probed every second) in details.appPool; a queue of 5+ requests becomes one Audit Log
    warning system.db.pool_exhausted per 5 minutes.
No migration; an app rollback restores the previous behaviour.

Steps: patch -> prepare -> quick (optional) -> validate -> build -> deploy (verifies; rolls the app
back on failure) -> verify.
"""
import json,os,runpy,signal,subprocess,sys,time
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
prev=previous['prev']
split,sor,base=prev['split'],prev['sor'],prev['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/special-list-stall-20261106'
PATCH=OUT/'change.patch'
# Kept beside the tool: server/deployments is subject to copy retention, tools/ is not.
CODE_PATCH=Path(__file__).with_name('special-list-stall-release.code.patch')
FILES=['src/special-stock-status-refresh.js','src/server.js','src/db.js','src/system-resource-monitor.js']
IMAGE='mbbs-operator-app:special-list-stall-20261106'
ROLLBACK='mbbs-operator-app:special-list-stall-rollback-20261106'
TARGET_FILES=['test/special-list-stall/special-list-stall.test.js','test/special-list-stall/special-list-stall-http.test.js']
EXPECTED_TARGET=9
# Live must fail exactly these (the new behaviour) and nothing else in the target files.
U='test/special-list-stall/special-list-stall.test.js :: '
H='test/special-list-stall/special-list-stall-http.test.js :: '
NEW_TESTS={U+name for name in (
  'a list load joins the batch in progress and reloads pages only when a status changed',
  'a failed background refresh is logged and never reaches the page request',
  'an order NetSuite does not return (deleted PO) is not asked again for 5 minutes unless forced',
  'a failed NetSuite call holds those orders off, and a later answer clears the hold',
  'the app database pool allows 30 connections by default and DATABASE_POOL_MAX overrides it',
  'requests queued for a database connection become one Audit Log warning per 5 minutes',
  'each resource sample stores the peak connection queue of its interval')}|{H+name for name in (
  'Sales and SCM lists answer from saved statuses while NetSuite has not replied; one batch runs; statuses follow',
  'an unchanged NetSuite status renews freshness without an audit row or mirror event; a change still records both')}
REGRESSION=[f'test/{name}.test.js' for name in '''
mbt/unit/special-status-following mbt/integration/special-status-following
resource-monitor/resource-monitor performance/performance
mbt/integration/special-stock-request-http.red mbt/unit/special-stock-request-wiring.red
mbt/integration/special-enhancements-http mbt/integration/special-stock-updates-http mbt/integration/special-stock-alert-http
mbt/integration/special-approval-http mbt/integration/special-case-edits-http mbt/integration/special-case-fields-http
mbt/integration/special-custom-po-http mbt/integration/special-delivery-fee-http mbt/integration/special-delivery-method-http
mbt/integration/special-header-note-http mbt/integration/special-independent-po-http mbt/integration/special-line-decline-http
mbt/integration/special-po-note-http mbt/integration/special-po-unsubmitted-link-http mbt/integration/special-quote-pallet-http
mbt/integration/special-sales-internal-remark-http mbt/integration/special-sales-items-copy-http
mbt/integration/special-sales-request-corrections-http mbt/integration/special-stock-check-editing-http
mbt/integration/special-workflow-polish-http mbt/integration/special-workflow-pricing-http
mbt/integration/special-customer-confirmation mbt/integration/special-vendor-confirmation
mbt/integration/special-vendor-pickup-replacement mbt/integration/special-po-reference-only
mbt/integration/stock-request-alert-list-http mbt/integration/stock-request-alert-messages-http
mbt/integration/stock-request-search-across-statuses mbt/integration/backorder-requests mbt/integration/backorder-po-routing
mbt/integration/special-enhancements-browser mbt/integration/special-stock-updates-browser
mbt/integration/special-stock-alert-browser mbt/integration/stock-request-alert-list-browser
'''.split()]

EDITS=[
  # --- Special status refresh -------------------------------------------------------------------
  ('src/special-stock-status-refresh.js','''  return withTransaction(async () => {
    const result = await query(`UPDATE ${kind.table} header
      SET status=$2, status_text=$3, synced_at=now(),
          status_updated_at=CASE WHEN status IS DISTINCT FROM $2 OR status_text IS DISTINCT FROM $3 THEN now() ELSE status_updated_at END
      WHERE netsuite_id=$1 AND tranid=$5 AND synced_at IS NOT DISTINCT FROM $4::timestamptz
        AND EXISTS (SELECT 1 FROM sales_special_stock_cases special WHERE special.${kind.link}=header.netsuite_id)
      RETURNING netsuite_id`, [observation.netsuiteOrderId, observation.status, observation.statusText, observation.syncedAt, observation.tranid]);
    if (!result.rowCount) return false;
''','''  return withTransaction(async () => {
    // The fence (synced_at) still applies; previous reads the locked row so an unchanged status is known.
    const result = await query(`WITH previous AS (
        SELECT netsuite_id, status AS previous_status, status_text AS previous_status_text FROM ${kind.table}
        WHERE netsuite_id=$1 FOR UPDATE)
      UPDATE ${kind.table} header
      SET status=$2, status_text=$3, synced_at=now(),
          status_updated_at=CASE WHEN status IS DISTINCT FROM $2 OR status_text IS DISTINCT FROM $3 THEN now() ELSE status_updated_at END
      FROM previous
      WHERE header.netsuite_id=previous.netsuite_id AND header.tranid=$5 AND header.synced_at IS NOT DISTINCT FROM $4::timestamptz
        AND EXISTS (SELECT 1 FROM sales_special_stock_cases special WHERE special.${kind.link}=header.netsuite_id)
      RETURNING header.netsuite_id, (previous.previous_status IS DISTINCT FROM $2 OR previous.previous_status_text IS DISTINCT FROM $3) AS changed`,
    [observation.netsuiteOrderId, observation.status, observation.statusText, observation.syncedAt, observation.tranid]);
    // An unchanged status only renews freshness: no audit row, mirror event or page reload.
    if (!result.rowCount || result.rows[0].changed !== true) return false;
'''),
  ('src/special-stock-status-refresh.js','''  /** @param {Record<string,any>[]} details @param {{force?:boolean}} options */
  return async (details, { force = false } = {}) => {
    const result = { attempted: 0, updated: 0, failed: 0 };
    for (const kind of kinds) {
      const orders = staleOrders(details, kind.prefix, now(), force);
      if (!orders.length) continue;
      result.attempted += orders.length;
      let rows;
      try { rows = await fetchStatuses(orders.map(order => order.netsuiteOrderId), kind.recordType); }
      catch (error) { result.failed += orders.length; logger.error('Special order status refresh failed', kind.orderType, String(error instanceof Error ? error.message : error)); continue; }
      for (const order of orders) {
        const matches = Array.isArray(rows) ? rows.filter(row => identity(row?.id) === order.netsuiteOrderId) : [];
        if (matches.length !== 1 || !verifiedStatus(matches[0], order)) {
          result.failed++; logger.error('Special order status response is missing or invalid', kind.orderType, order.netsuiteOrderId); continue;
        }
''','''  // An order NetSuite did not answer for (deleted, malformed, or a failed call) is not asked again for
  // MAX_AGE_MS unless forced, so a PO deleted in NetSuite is not re-read and logged on every list load.
  /** @type {Map<string,number>} */
  const retryAt = new Map();
  /** @param {string} type @param {{netsuiteOrderId:number}} order @param {number} at */
  const holdOff = (type, order, at) => {
    if (retryAt.size >= 5000) for (const [key, until] of retryAt) if (until <= at) retryAt.delete(key);
    retryAt.set(`${type}:${order.netsuiteOrderId}`, at + MAX_AGE_MS);
  };
  /** @param {Record<string,any>[]} details @param {{force?:boolean}} options */
  return async (details, { force = false } = {}) => {
    const result = { attempted: 0, updated: 0, failed: 0 };
    for (const kind of kinds) {
      const current = now(), at = Number(current);
      const orders = staleOrders(details, kind.prefix, current, force)
        .filter(order => force || !((retryAt.get(`${kind.orderType}:${order.netsuiteOrderId}`) ?? 0) > at));
      if (!orders.length) continue;
      result.attempted += orders.length;
      let rows;
      try { rows = await fetchStatuses(orders.map(order => order.netsuiteOrderId), kind.recordType); }
      catch (error) {
        result.failed += orders.length;
        for (const order of orders) holdOff(kind.orderType, order, at);
        logger.error('Special order status refresh failed', kind.orderType, String(error instanceof Error ? error.message : error)); continue;
      }
      for (const order of orders) {
        const matches = Array.isArray(rows) ? rows.filter(row => identity(row?.id) === order.netsuiteOrderId) : [];
        if (matches.length !== 1 || !verifiedStatus(matches[0], order)) {
          result.failed++; holdOff(kind.orderType, order, at);
          logger.error('Special order status response is missing or invalid', kind.orderType, order.netsuiteOrderId); continue;
        }
        retryAt.delete(`${kind.orderType}:${order.netsuiteOrderId}`);
'''),
  ('src/special-stock-status-refresh.js','''export function refreshSpecialOrderStatusCache(details, options = {}) {
  return config.netsuite?.directAccessEnabled ? refresh(details, options) : Promise.resolve({ attempted: 0, updated: 0, failed: 0 });
}
''','''export function refreshSpecialOrderStatusCache(details, options = {}) {
  return config.netsuite?.directAccessEnabled ? refresh(details, options) : Promise.resolve({ attempted: 0, updated: 0, failed: 0 });
}

/** List pages answer from saved statuses; stale SO/PO statuses refresh afterwards, one batch at a time,
 * and onUpdated (a page reload event) runs only when a status changed. A list load never waits for NetSuite.
 * @param {{refresh?:(details:Record<string,any>[])=>Promise<{attempted:number,updated:number,failed:number}>,
 *   onUpdated?:(result:{attempted:number,updated:number,failed:number})=>void,logger?:{error:(...args:any[])=>void}}} dependencies */
export function createBackgroundSpecialStatusRefresh(dependencies = {}) {
  const { refresh: refreshStatuses = refreshSpecialOrderStatusCache, onUpdated = () => {}, logger = console } = dependencies;
  /** @type {Promise<{attempted:number,updated:number,failed:number}>|null} */
  let running = null;
  /** @param {Record<string,any>[]} details */
  return details => {
    // The batch in progress covers this load; anything still stale is picked up by the next load.
    if (running) return running;
    running = Promise.resolve().then(() => refreshStatuses(details))
      .then(result => { if (result.updated) onUpdated(result); return result; })
      .catch(error => {
        logger.error('Special order status refresh failed', String(error instanceof Error ? error.message : error));
        return { attempted: 0, updated: 0, failed: 0 };
      })
      .finally(() => { running = null; });
    return running;
  };
}
'''),
  # --- Special list endpoints answer without waiting for NetSuite ------------------------------
  ('src/server.js',"import { refreshSpecialOrderStatusCache } from './special-stock-status-refresh.js';",
   "import { refreshSpecialOrderStatusCache, createBackgroundSpecialStatusRefresh } from './special-stock-status-refresh.js';"),
  ('src/server.js','''/** @param {()=>Promise<any>} read */
async function readSpecialWithCurrentOrderStatuses(read) {
  const saved = await read();
  const result = await refreshSpecialOrderStatusCache(Array.isArray(saved) ? saved : [saved]);''',
   '''// Special list pages answer from saved statuses and never wait for NetSuite; stale SO/PO statuses refresh
// afterwards, one batch at a time, and only a changed status reloads open pages (2026-11-06 list stall).
const refreshSpecialListStatuses = createBackgroundSpecialStatusRefresh({ onUpdated: () => emitSpecialStockUpdate('order-status-refresh') });

/** @param {()=>Promise<any>} read @param {{background?:boolean}} [options] */
async function readSpecialWithCurrentOrderStatuses(read, { background = false } = {}) {
  const saved = await read();
  if (background) { void refreshSpecialListStatuses(Array.isArray(saved) ? saved : [saved]); return saved; }
  const result = await refreshSpecialOrderStatusCache(Array.isArray(saved) ? saved : [saved]);'''),
  ('src/server.js','''        authorizedStoreLocationIds: operatorSalesYardLocationIds(req.operator)
      }))
    });''','''        authorizedStoreLocationIds: operatorSalesYardLocationIds(req.operator)
      }), { background: true })
    });'''),
  ('src/server.js','''requests: await readSpecialWithCurrentOrderStatuses(() => listSpecialStockCases({ ...req.query, audience: "scm", authorizedStoreLocationIds: undefined, requestedByOperatorId: undefined })) });''',
   '''requests: await readSpecialWithCurrentOrderStatuses(() => listSpecialStockCases({ ...req.query, audience: "scm", authorizedStoreLocationIds: undefined, requestedByOperatorId: undefined }), { background: true }) });'''),
  # --- App connection pool ------------------------------------------------------------------------
  ('src/db.js','''export const pool = new Pool({
  connectionString: config.databaseUrl,
  options: "-c jit=off"
});''','''// node-postgres defaults to 10 connections. On 2026-11-06 a few transactions held connections while
// waiting on other work and every page queued behind them; PostgreSQL allows 100 (about 22 in use).
export const DATABASE_POOL_MAX = Math.min(50, Math.max(1, Number.parseInt(process.env.DATABASE_POOL_MAX || "", 10) || 30));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: DATABASE_POOL_MAX,
  options: "-c jit=off"
});'''),
  # --- Pool queue in the resource monitor -----------------------------------------------------------
  ('src/system-resource-monitor.js',"import { query } from './db.js';","import { pool as appDatabasePool, query } from './db.js';"),
  ('src/system-resource-monitor.js','longQueryErrorSeconds?: number}} [options] */',
   'longQueryErrorSeconds?: number, poolWaitingWarn?: number, poolRepeatMs?: number}} [options] */'),
  ('src/system-resource-monitor.js','''  longQuerySeconds = 60,
  longQueryErrorSeconds = 300
} = {}) {''','''  longQuerySeconds = 60,
  longQueryErrorSeconds = 300,
  poolWaitingWarn = 5,
  poolRepeatMs = 5 * 60_000
} = {}) {'''),
  ('src/system-resource-monitor.js','  let eventLoopLastAlertAt = 0;\n','  let eventLoopLastAlertAt = 0;\n  let poolLastAlertAt = 0;\n'),
  ('src/system-resource-monitor.js','''    const seen = new Set();
''','''    // Requests queued for one of the app's database connections: every page waits behind them (2026-11-06).
    const appPool = sample.appPool;
    if (appPool && Number.isFinite(appPool.waitingMax) && appPool.waitingMax >= poolWaitingWarn && now - poolLastAlertAt >= poolRepeatMs) {
      poolLastAlertAt = now;
      emit({ severity: 'warning', action: 'system.db.pool_exhausted',
        message: `All ${appPool.max ?? '?'} app database connections were busy; up to ${appPool.waitingMax} requests waited for one. ${context(sample)}`,
        details: { ...details, appPool } });
    }

    const seen = new Set();
'''),
  ('src/system-resource-monitor.js','pool?: {query: Function, end?: Function}, now?: () => number}} [options] */',
   'pool?: {query: Function, end?: Function}, now?: () => number,\n *  appPool?: {waitingCount?: number, totalCount?: number, idleCount?: number, options?: {max?: number}}|null, poolProbeMs?: number}} [options] */'),
  ('src/system-resource-monitor.js','''  pool = null,
  now = Date.now
} = {}) {''','''  pool = null,
  now = Date.now,
  appPool = appDatabasePool,
  poolProbeMs = 1000
} = {}) {'''),
  ('src/system-resource-monitor.js','  let lastFailureAt = 0;\n','''  let lastFailureAt = 0;
  // Peak number of requests queued for one of this process's database connections since the last
  // sample, probed every second so a short exhaustion between two samples is still recorded.
  let poolWaitingMax = 0;
  const probePool = () => { poolWaitingMax = Math.max(poolWaitingMax, Number(appPool?.waitingCount) || 0); };
  const poolTimer = appPool ? setInterval(probePool, poolProbeMs) : null;
  poolTimer?.unref?.();
'''),
  ('src/system-resource-monitor.js','''    const longest = db.longQueries[0] || null;
''','''    const longest = db.longQueries[0] || null;
    probePool();
    const appPoolUse = appPool ? { max: appPool.options?.max ?? null, total: appPool.totalCount ?? null, idle: appPool.idleCount ?? null,
      waitingNow: Number(appPool.waitingCount) || 0, waitingMax: poolWaitingMax } : null;
    poolWaitingMax = 0;
'''),
  ('src/system-resource-monitor.js','''      dbError: db.error || null
    };''','''      dbError: db.error || null,
      appPool: appPoolUse
    };'''),
  ('src/system-resource-monitor.js','''      ...(sample.dbError ? { dbError: sample.dbError } : {})
    };''','''      ...(sample.dbError ? { dbError: sample.dbError } : {}),
      ...(sample.appPool ? { appPool: sample.appPool } : {})
    };'''),
  ('src/system-resource-monitor.js','''      clearInterval(timer);
      eventLoop.disable();''','''      clearInterval(timer);
      if (poolTimer) clearInterval(poolTimer);
      eventLoop.disable();'''),
]
MARKERS={'src/special-stock-status-refresh.js':'createBackgroundSpecialStatusRefresh','src/server.js':'refreshSpecialListStatuses',
  'src/db.js':'DATABASE_POOL_MAX','src/system-resource-monitor.js':'system.db.pool_exhausted'}
UNRELATED=('aiChat','ai-chat','AiChat','client-error-reporter','autoRetry','adminRepost','waiting_customer_pickup',
  'operatorCoCandidatesSql','netsuite_closed')
MAX_CHANGED_LINES=170
for scope in (split,sor):scope.update(OUT=OUT)
split.update(PATCH=PATCH,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
prev.update(OUT=OUT,FILES=FILES,TARGET_FILES=TARGET_FILES,REGRESSION=REGRESSION)
save,sha=base['save'],base['sha']
base['apply_migration']=lambda:{'migration':None}

def make_patch():
    """Capture live, apply exactly EDITS to a copy of each live file and store the resulting patch."""
    sor['capture']()
    live,staged=OUT/'live-before',OUT/'patch-stage'
    subprocess.run(['rm','-rf','--',str(staged)],check=True)
    texts={name:(live/name).read_text(encoding='utf-8') for name in FILES}
    for name,old,new in EDITS:
        assert texts[name].count(old)==1,(name,'live text not found exactly once',old[:120])
        texts[name]=texts[name].replace(old,new)
    parts=[]
    for name in FILES:
        target=staged/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(texts[name],encoding='utf-8')
        result=subprocess.run(['diff','-u','--label',f'a/server/{name}','--label',f'b/server/{name}',str(live/name),str(target)],
          capture_output=True,text=True)
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
    with PATCH.open('rb') as patch:
        subprocess.run(['patch','-p2','--fuzz=0','--no-backup-if-mismatch','--batch','-d',str(candidate)],stdin=patch,check=True)
    differs=prev['changed_files'](live,candidate)
    assert differs==sorted(FILES),('Candidate must differ from live in exactly the release files',differs)
    diff,changed=[],0
    for name in FILES:
        one=subprocess.run(['git','diff','--no-index','--',str(live/name),str(candidate/name)],capture_output=True,text=True).stdout
        lines=[line for line in one.splitlines() if line[:1] in '+-' and line[:3] not in ('+++','---')]
        added=[line for line in lines if line.startswith('+')]
        assert any(MARKERS[name] in line for line in added),name
        assert not any(word in line for line in added for word in UNRELATED),f'{name}: unrelated work in candidate'
        changed+=len(lines);diff.append(one)
    assert changed<=MAX_CHANGED_LINES,('Release diff is larger than this change',changed)
    (OUT/'release.patch').write_text(''.join(diff))
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
    checks=' && '.join([*(f'node --check {name}' for name in [*FILES,*TARGET_FILES]),
      'node_modules/.bin/eslint --config eslint.mbt.config.js --max-warnings=0 '+' '.join(TARGET_FILES)])
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
        if any(tree.get(f,{}).get('failed') for f in [*TARGET_FILES,*extra]):
            print((art/f'{label}.log').read_text()[-6000:])

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
    # A `docker builder prune` hung since 2026-08 is ignored, as the other release tools do.
    running=subprocess.run(['pgrep','-af',r'docker(-buildx)? (buildx )?build( |$)|compose .* build( |$)'],capture_output=True,text=True).stdout.strip()
    assert not running,('Another docker build is running; overlapping builds crashed dockerd on 2026-11-03',running)
    split['build']()

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; patch, prepare and validate again'
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    base['deploy']()
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n# No migration.\n')

# Read-only: the running app has the 30-connection pool and the background list refresh.
LIVE_CHECK=r'''
const { pool, closeDb } = await import("/app/src/db.js");
const status = await import("/app/src/special-stock-status-refresh.js");
console.log(JSON.stringify({ poolMax: pool.options.max, background: typeof status.createBackgroundSpecialStatusRefresh }));
await closeDb();
'''

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    codes={}
    for path in ('/api/scm/special-stock-requests','/api/sales/special-stock-requests'):
        codes[path]=int(subprocess.check_output(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}',
          'http://127.0.0.1:3000'+path],text=True))
        assert codes[path] in (401,403),f'{path} unauthenticated: {codes[path]}'
    observed=json.loads(base['docker']('exec','-i','-w','/app',APP,'node','--input-type=module',data=LIVE_CHECK.encode()).splitlines()[-1])
    assert observed=={'poolMax':30,'background':'function'},observed
    # The running app stores its pool figures with the next 30 s resource sample.
    started=base['metadata'](APP).get('startedAt') or ''
    sample=''
    for _ in range(18):
        sample=base['db']("SET default_transaction_read_only=on; SELECT details->'appPool' FROM system_resource_samples "
          "WHERE process_name='app' AND details ? 'appPool' AND sampled_at > now() - interval '2 minutes' ORDER BY sampled_at DESC LIMIT 1;")
        if sample.strip():break
        time.sleep(5)
    assert sample.strip(),'No resource sample with appPool after deploy'
    pool=json.loads(sample)
    assert pool.get('max')==30,pool
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'unauthenticated':codes,'app':observed,
      'appPoolSample':pool,'containerStartedAt':started})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'app':observed,'appPoolSample':pool}))
base['verify']=verify

if __name__=='__main__':
    {'patch':make_patch,'prepare':prepare,'quick':quick,'validate':validate,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()
