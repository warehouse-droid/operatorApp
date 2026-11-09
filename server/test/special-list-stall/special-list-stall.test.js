// 2026-11-06 21:05-21:23 UTC: the Special Request list took up to 105 s while other pages slowed too.
// The app's 10 database connections were all busy, and each list load read the list, waited for
// NetSuite, saved every stale status (one transaction each), broadcast a page reload even when
// nothing changed, and read the list again. These tests pin the fixes that keep it from recurring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const statusModule = await import('../../src/special-stock-status-refresh.js');
const monitorModule = await import('../../src/system-resource-monitor.js');
const dbModule = await import('../../src/db.js');

const start = new Date('2026-11-06T21:20:00Z');
const old = '2026-11-06T20:00:00.000Z';
const detail = { id: 176, salesOrderId: 1087001, salesOrderRef: 'SOB123860', salesOrderStatusSyncedAt: old,
  purchaseOrderId: 1087313, purchaseOrderRef: 'POB04206', purchaseOrderStatusSyncedAt: old };
const sales = { id: '1087001', tranid: 'SOB123860', status: 'B', status_text: 'Sales Order : Pending Fulfillment' };

function cache({ fetchStatuses, clock }) {
  const reads = [], errors = [];
  const refresh = statusModule.createSpecialOrderStatusCache({ now: () => clock.now,
    fetchStatuses: async (ids, type) => { reads.push({ ids, type }); return fetchStatuses(ids, type); },
    persist: async () => true, logger: { error: (...args) => errors.push(args) } });
  return { refresh, reads, errors };
}

test('a list load joins the batch in progress and reloads pages only when a status changed', async () => {
  assert.equal(typeof statusModule.createBackgroundSpecialStatusRefresh, 'function', 'list refresh runs in the background');
  const calls = [], updates = [], errors = [];
  let release, result = { attempted: 2, updated: 0, failed: 0 };
  const refresh = statusModule.createBackgroundSpecialStatusRefresh({
    refresh: async details => { calls.push(details); await new Promise(done => { release = done; }); return result; },
    onUpdated: value => updates.push(value), logger: { error: (...args) => errors.push(args) } });
  const first = refresh([detail]), second = refresh([detail, detail]);
  assert.equal(first, second, 'a second load while NetSuite is answering joins the same batch');
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  release();
  assert.deepEqual(await first, result);
  assert.deepEqual(updates, [], 'unchanged statuses broadcast no page reload');
  result = { attempted: 2, updated: 1, failed: 0 };
  const next = refresh([detail]);
  await new Promise(setImmediate);
  release();
  assert.deepEqual(await next, result);
  assert.equal(calls.length, 2);
  assert.deepEqual(updates, [result], 'a changed status reloads open pages once');
  assert.deepEqual(errors, []);
});

test('a failed background refresh is logged and never reaches the page request', async () => {
  assert.equal(typeof statusModule.createBackgroundSpecialStatusRefresh, 'function', 'list refresh runs in the background');
  const errors = [];
  const refresh = statusModule.createBackgroundSpecialStatusRefresh({ refresh: async () => { throw Error('TEST NetSuite timeout'); },
    onUpdated: () => assert.fail('no reload after a failure'), logger: { error: (...args) => errors.push(args) } });
  assert.deepEqual(await refresh([detail]), { attempted: 0, updated: 0, failed: 0 });
  assert.match(errors[0].join(' '), /TEST NetSuite timeout/);
});

test('an order NetSuite does not return (deleted PO) is not asked again for 5 minutes unless forced', async () => {
  const clock = { now: start };
  const h = cache({ clock, fetchStatuses: async (_ids, type) => type === 'SalesOrd' ? [sales] : [] });
  assert.deepEqual(await h.refresh([detail]), { attempted: 2, updated: 1, failed: 1 });
  assert.equal(h.errors.length, 1);
  // The SO was saved; the next load still has the PO's old timestamp, as the deleted PO 1087313 did.
  const later = { ...detail, salesOrderStatusSyncedAt: start.toISOString() };
  assert.deepEqual(await h.refresh([later]), { attempted: 0, updated: 0, failed: 0 }, 'the missing PO is not re-read on the next load');
  assert.equal(h.reads.length, 2);
  assert.equal(h.errors.length, 1, 'and not logged again');
  assert.deepEqual(await h.refresh([later], { force: true }), { attempted: 2, updated: 1, failed: 1 }, 'an explicit Refresh still asks NetSuite');
  clock.now = new Date(start.getTime() + 4 * 60_000);
  assert.equal((await h.refresh([later])).attempted, 0);
  clock.now = new Date(start.getTime() + 5 * 60_000 + 1);
  const freshSales = { ...later, salesOrderStatusSyncedAt: clock.now.toISOString() };
  assert.deepEqual(await h.refresh([freshSales]), { attempted: 1, updated: 0, failed: 1 }, 'asked again after 5 minutes');
});

test('a failed NetSuite call holds those orders off, and a later answer clears the hold', async () => {
  const clock = { now: start };
  let outage = true;
  const h = cache({ clock, fetchStatuses: async ids => { if (outage) throw Error('TEST NetSuite unavailable');
    return ids.map(id => ({ id: String(id), tranid: `SO${id}`, status: 'B', status_text: 'Sales Order : Pending Fulfillment' })); } });
  const input = [{ salesOrderId: 501, salesOrderRef: 'SO501', salesOrderStatusSyncedAt: old }];
  assert.deepEqual(await h.refresh(input), { attempted: 1, updated: 0, failed: 1 });
  assert.equal((await h.refresh(input)).attempted, 0, 'a slow or failing NetSuite is not hammered by every load');
  outage = false;
  clock.now = new Date(start.getTime() + 5 * 60_000 + 1);
  assert.deepEqual(await h.refresh(input), { attempted: 1, updated: 1, failed: 0 });
  assert.equal((await h.refresh(input)).attempted, 1, 'an answered order is refreshed normally while still stale');
});

test('the app database pool allows 30 connections by default and DATABASE_POOL_MAX overrides it', () => {
  assert.equal(dbModule.pool.options.max, 30);
  const read = value => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { pool } = await import(${JSON.stringify(new URL('../../src/db.js', import.meta.url).href)}); console.log(pool.options.max); await pool.end();`],
    { env: { ...process.env, DATABASE_POOL_MAX: value }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return Number(result.stdout.trim().split('\n').pop());
  };
  assert.equal(read('12'), 12);
  assert.equal(read('not-a-number'), 30);
  assert.equal(read('500'), 50, 'capped well below PostgreSQL max_connections (100)');
});

test('requests queued for a database connection become one Audit Log warning per 5 minutes', () => {
  const events = [];
  const alerts = monitorModule.createResourceAlerts({ record: event => events.push(event) });
  const sample = waitingMax => ({ intervalMs: 30_000, hostCpuPercent: 40, appCpuPercent: 5, hostMemoryAvailablePercent: 50,
    dbActiveQueries: 20, dbConnections: 24, longQueries: [],
    appPool: { max: 20, total: 20, idle: 0, waitingNow: 0, waitingMax } });
  const at = start.getTime();
  alerts.observe(sample(2), at);
  assert.equal(events.length, 0, 'a brief queue of 2 is normal');
  alerts.observe(sample(37), at + 30_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'system.db.pool_exhausted');
  assert.equal(events[0].severity, 'warning');
  assert.match(events[0].message, /All 20 app database connections were busy; up to 37 requests waited/);
  assert.equal(events[0].details.appPool.waitingMax, 37);
  alerts.observe(sample(40), at + 60_000);
  assert.equal(events.length, 1, 'repeats at most every 5 minutes');
  alerts.observe(sample(12), at + 30_000 + 5 * 60_000);
  assert.equal(events.length, 2);
});

test('each resource sample stores the peak connection queue of its interval', async () => {
  const inserts = [];
  const db = { query: async (sql, params) => {
    if (/INSERT INTO system_resource_samples/.test(sql)) { inserts.push(params); return { rows: [] }; }
    if (/DELETE FROM system_resource_samples/.test(sql)) return { rows: [] };
    if (/FILTER \(WHERE backend_type/.test(sql)) return { rows: [{ connections: 24, active: 20, waiting: 0, parallel_workers: 0 }] };
    return { rows: [] };
  } };
  const appPool = { options: { max: 20 }, totalCount: 20, idleCount: 0, waitingCount: 9 };
  const monitor = monitorModule.startSystemResourceMonitor({ enabled: true, processName: 'app', intervalMs: 3_600_000,
    pool: db, appPool, poolProbeMs: 5, alerts: { observe: () => {} }, readFile: async () => '' });
  try {
    await new Promise(done => setTimeout(done, 60));
    appPool.waitingCount = 1;
    await monitor.sampleNow();
    assert.equal(inserts.length, 1);
    const details = JSON.parse(inserts[0].at(-1));
    assert.deepEqual(details.appPool, { max: 20, total: 20, idle: 0, waitingNow: 1, waitingMax: 9 },
      'a queue between two samples is still seen');
    appPool.waitingCount = 0;
    await monitor.sampleNow();
    assert.deepEqual(JSON.parse(inserts[1].at(-1)).appPool.waitingMax, 0, 'each interval starts again');
  } finally {
    await monitor.stop();
  }
});
