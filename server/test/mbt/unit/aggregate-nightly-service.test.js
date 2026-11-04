import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { aggregateReconciliationNightlyTick } from '../../../src/aggregate-reconciliation-service.js';
const source = readFileSync('src/aggregate-reconciliation-service.js', 'utf8').replace(/^import.*\n/gm, '').replace('export async function', 'async function');

test('S1 operational work defers before claiming; overlapping ticks cannot create duplicate workers', async () => {
  let claims = 0; let executes = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({ Date, claimAggregateNightlyRun: async () => { claims++; return { started: true, run: { id: 1 } }; },
    executeScmReconciliationRun: async () => { executes++; await gate; return { status: 'succeeded' }; } });
  vm.runInContext(source, context);
  assert.equal((await context.aggregateReconciliationNightlyTick({ operationalSyncRunning: () => true })).reason, 'operational_sync_running');
  assert.equal(claims, 0);
  const first = context.aggregateReconciliationNightlyTick({});
  await Promise.resolve(); await Promise.resolve();
  assert.equal((await context.aggregateReconciliationNightlyTick({})).reason, 'tick_in_progress');
  release(); assert.equal((await first).run.status, 'succeeded');
  assert.equal(claims, 1); assert.equal(executes, 1);
});

test('S1 claim misses and races defer; unexpected errors release the timer guard', async () => {
  const context = vm.createContext({ Date, claimAggregateNightlyRun: async () => ({ started: false, reason: 'disabled' }), executeScmReconciliationRun: async () => { throw new Error('must not execute'); } });
  vm.runInContext(source, context);
  assert.equal((await context.aggregateReconciliationNightlyTick()).reason, 'disabled');
  context.claimAggregateNightlyRun = async () => { throw Object.assign(new Error('active'), { status: 409 }); };
  assert.equal((await context.aggregateReconciliationNightlyTick()).reason, 'reconciliation_active');
  context.claimAggregateNightlyRun = async () => { throw new Error('db down'); };
  await assert.rejects(context.aggregateReconciliationNightlyTick(), /db down/);
  context.claimAggregateNightlyRun = async () => ({ started: false, reason: 'already_attempted' });
  assert.equal((await context.aggregateReconciliationNightlyTick()).reason, 'already_attempted');
});

test('S3/I1 production dispatcher and source resolution retain the aggregate filter without the old 15-minute timer', () => {
  const service = readFileSync('src/scm-reconciliation-service.js', 'utf8');
  const server = readFileSync('src/server.js', 'utf8');
  assert.match(service, /run\.sourceFilter === AGGREGATE_SOURCE_FILTER\s*\? await listPendingAggregateReconciliationSources\(\)/);
  assert.match(service, /sourceFilter: row\.source_filter \|\| row\.sourceFilter/);
  assert.match(server, /await aggregateReconciliationNightlyTick\(\{ operationalSyncRunning: anyNetSuiteSyncRunning \}\)/);
  assert.doesNotMatch(server, /set(?:Timeout|Interval)\([^\n]*scmScheduleStatusRefreshTick/);
});

test('S1 actual timer defers overlapping probes and recovers after probe errors', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = aggregateReconciliationNightlyTick({ operationalSyncRunning: () => gate });
  assert.equal((await aggregateReconciliationNightlyTick()).reason, 'tick_in_progress');
  release(true);
  assert.equal((await first).reason, 'operational_sync_running');
  await assert.rejects(aggregateReconciliationNightlyTick({ operationalSyncRunning: () => { throw new Error('operational probe unavailable'); } }), /probe unavailable/);
  assert.equal((await aggregateReconciliationNightlyTick({ operationalSyncRunning: () => { throw Object.assign(new Error('active worker'), { status: 409 }); } })).reason, 'reconciliation_active');
  assert.equal((await aggregateReconciliationNightlyTick({ operationalSyncRunning: () => true })).reason, 'operational_sync_running');
});

test('the nightly aggregate run also refreshes open Special vendor pickups, even when the run fails', async () => {
  const order = [];
  const context = vm.createContext({ Date, String, Error,
    claimAggregateNightlyRun: async () => ({ started: true, run: { id: 7 } }),
    executeScmReconciliationRun: async () => { order.push('run'); return { status: 'succeeded' }; },
    refreshOpenSpecialVendorPickupOrders: async () => { order.push('vendor-pickup'); return { requests: 1, updated: 1, completedRequestIds: [9] }; } });
  vm.runInContext(source, context);
  const result = await context.aggregateReconciliationNightlyTick({});
  assert.deepEqual(order, ['run', 'vendor-pickup']);
  assert.equal(result.run.status, 'succeeded'); assert.deepEqual(result.specialVendorPickup.completedRequestIds, [9]);
  order.length = 0;
  context.executeScmReconciliationRun = async () => { order.push('run'); throw new Error('NetSuite timeout'); };
  await assert.rejects(context.aggregateReconciliationNightlyTick({}), /NetSuite timeout/);
  assert.deepEqual(order, ['run', 'vendor-pickup']);
  context.executeScmReconciliationRun = async () => ({ status: 'succeeded' });
  context.refreshOpenSpecialVendorPickupOrders = async () => { throw new Error('refresh failed'); };
  const isolated = await context.aggregateReconciliationNightlyTick({});
  assert.equal(isolated.run.status, 'succeeded'); assert.match(isolated.specialVendorPickup.error, /refresh failed/);
});
