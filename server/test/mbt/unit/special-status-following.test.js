import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { specialOrderStatusFields, createSpecialOrderStatusCache } from '../../../src/special-stock-status-refresh.js';
import { specialPlanningStatus } from '../../../public/special-stock-case-status.js';
import { watchSpecialQueue } from '../../../public/special-stock-queue.js';

const now = new Date('2026-10-05T14:00:00Z');
const old = '2026-10-02T18:33:06.937Z';
const detail = { id: 95, salesOrderId: 1033108, salesOrderRef: 'SOB121882', salesOrderStatusSyncedAt: old,
  purchaseOrderId: 995310, purchaseOrderRef: 'POB03883', purchaseOrderStatusSyncedAt: old,
  salesOrderStatus: 'Sales Order : Pending Billing', purchaseOrderStatus: 'Purchase Order : Pending Bill',
  purchaseOrderApproved: true, operationallyComplete: true, fulfillmentMethod: 'mbt_delivery', purchaseOrderReceiptStatus: 'received',
  dispatchPlanning: { anyPlanned: true, salesOrder: { planned: true, plans: [{ planDate: '2026-10-05', estimatedArrivalMinute: 593 }] },
    purchaseOrder: { planned: true, plans: [{ planDate: '2026-10-02', estimatedArrivalMinute: 1021 }] } } };
const sales = { id: '1033108', tranid: 'SOB121882', status: 'F', status_text: 'Sales Order : Pending Billing' };
const purchase = { id: '995310', tranid: 'POB03883', status: 'F', status_text: 'Purchase Order : Pending Bill' };
function harness(overrides = {}) {
  const reads = [], writes = [], errors = [];
  const refresh = createSpecialOrderStatusCache({ now: () => now,
    fetchStatuses: async (ids, type) => { reads.push({ ids, type }); return type === 'SalesOrd' ? [sales] : [purchase]; },
    persist: async observation => { writes.push(observation); return true; },
    logger: { error: (...args) => errors.push(args) }, ...overrides });
  return { refresh, reads, writes, errors };
}

for (const audience of ['sales', 'scm']) for (const compact of [false, true]) {
  test(`SPREQ-000024 shows Delivered and Arrived at yard for ${audience}, compact=${compact}`, () => {
    const html = specialPlanningStatus(detail, compact, { audience, showOrderPreviews: !compact });
    assert.match(html, /SO(?: delivery)?: Delivered/);
    assert.match(html, /PO(?: receipt)?: Arrived at yard/);
    assert.doesNotMatch(html, /Not planned|: Planned|Est\. arrival/);
    if (!compact && audience === 'scm') { assert.match(html, /NetSuite: Sales Order : Pending Billing/); assert.match(html, /NetSuite: Purchase Order : Pending Bill/); }
    if (audience === 'sales') assert.doesNotMatch(html,/NetSuite:|Pending Bill/);
  });
}
test('partial receipt is not complete and remote header alone never completes local delivery', () => {
  const html = specialPlanningStatus({ ...detail, operationallyComplete: false, purchaseOrderReceiptStatus: 'partial_received' }, false, { audience: 'sales' });
  assert.match(html, /PO receipt: Partially arrived at yard/);
  assert.match(html, /SO planning: Planned/);
  assert.doesNotMatch(html, /SO delivery: Delivered/);
});
test('canonical status projection replaces stale linking snapshot and exposes cache and receipt evidence', () => {
  assert.deepEqual(specialOrderStatusFields({ canonical_sales_status: 'F', canonical_sales_status_text: sales.status_text,
    sales_order_status: 'Old status', sales_order_approved: false, canonical_sales_synced_at: old,
    canonical_purchase_receipt_status: 'received', canonical_purchase_received_at: now, canonical_purchase_synced_at: old }), {
    salesOrderStatus: sales.status_text, salesOrderApproved: true, salesOrderStatusSyncedAt: old,
    purchaseOrderReceiptStatus: 'received', purchaseOrderReceivedAt: now, purchaseOrderStatusSyncedAt: old
  });
});
test('approval uses canonical pending/closed evidence and retains unsynced/test fallback', () => {
  for (const code of ['A', 'C', 'H']) assert.equal(specialOrderStatusFields({ canonical_sales_status: code, sales_order_approved: true }).salesOrderApproved, false);
  assert.equal(specialOrderStatusFields({ canonical_sales_status: 'B', canonical_sales_active: false, sales_order_approved: true }).salesOrderApproved, false);
  assert.equal(specialOrderStatusFields({ sales_order_status: 'Pending Fulfillment', sales_order_approved: true }).salesOrderStatus, 'Pending Fulfillment');
  assert.equal(specialOrderStatusFields({ sales_order_approved: true }).salesOrderApproved, true);
});
test('stale SO and PO refresh in separate batches with exact fenced observations and no business inputs', async () => {
  const h = harness();
  assert.deepEqual(await h.refresh([detail, detail]), { attempted: 2, updated: 2, failed: 0 });
  assert.deepEqual(h.reads, [{ ids: [1033108], type: 'SalesOrd' }, { ids: [995310], type: 'PurchOrd' }]);
  assert.deepEqual(h.writes, [
    { orderType: 'sales_order', netsuiteOrderId: 1033108, tranid: sales.tranid, status: 'F', statusText: sales.status_text, syncedAt: old },
    { orderType: 'purchase_order', netsuiteOrderId: 995310, tranid: purchase.tranid, status: 'F', statusText: purchase.status_text, syncedAt: old }
  ]);
});
test('fresh, unlinked, skipped and hostile identities do not read or persist', async () => {
  const h = harness();
  await h.refresh([{ ...detail, salesOrderStatusSyncedAt: now, purchaseOrderStatusSyncedAt: now }, {},
    { ...detail, salesOrderSkipped: true }, { ...detail, purchaseOrderSkipped: true },
    { salesOrderId: '1;DROP TABLE sales_orders', purchaseOrderId: -1 }]);
  assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
});
test('freshness boundary and missing/invalid/future timestamps refresh exactly when stale', async () => {
  for (const [stamp, expected] of [[new Date(now - 299999), 0], [new Date(now - 300000), 1], [null, 1], ['bad', 1], [new Date(+now + 1), 1]]) {
    const h = harness();
    assert.equal((await h.refresh([{ salesOrderId: 1033108, salesOrderRef: sales.tranid, salesOrderStatusSyncedAt: stamp }])).attempted, expected);
  }
});
test('explicit refresh bypasses freshness for both linked orders', async () => {
  const h = harness();
  assert.deepEqual(await h.refresh([{ ...detail, salesOrderStatusSyncedAt: now, purchaseOrderStatusSyncedAt: now }], { force: true }),
    { attempted: 2, updated: 2, failed: 0 });
  assert.equal(h.reads.length, 2);
});
for (const row of [null, { ...sales, id: '1033109' }, { ...sales, tranid: 'OTHER' }, { ...sales, status: '?' },
  { ...sales, status_text: '' }, { ...sales, status_text: 'x\nsecret' }]) {
  test(`reject malformed or foreign NetSuite response ${JSON.stringify(row)}`, async () => {
    const h = harness({ fetchStatuses: async () => row ? [row] : [] });
    assert.deepEqual(await h.refresh([{ ...detail, purchaseOrderId: null }]), { attempted: 1, updated: 0, failed: 1 });
    assert.equal(h.writes.length, 0);
    assert.equal(h.errors.length, 1);
  });
}
test('duplicate remote identities are ambiguous and cannot be persisted', async () => {
  const h = harness({ fetchStatuses: async () => [sales, sales] });
  assert.deepEqual(await h.refresh([{ ...detail, purchaseOrderId: null }]), { attempted: 1, updated: 0, failed: 1 });
  assert.equal(h.writes.length, 0); assert.equal(h.errors.length, 1);
});
test('a failed SO batch retains saved statuses while PO refresh proceeds and logs failure', async () => {
  const h = harness({ fetchStatuses: async (_ids, type) => { if (type === 'SalesOrd') throw Error('Unavailable'); return [purchase]; } });
  assert.deepEqual(await h.refresh([detail]), { attempted: 2, updated: 1, failed: 1 });
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].orderType, 'purchase_order'); assert.equal(h.errors.length, 1);
  assert.equal(detail.salesOrderStatus, sales.status_text);
});
test('an intervening webhook wins the persistence fence and persistence errors retain the cache', async () => {
  const h = harness({ persist: async observation => { if (observation.orderType === 'sales_order') return false; throw Error('Rolled back'); } });
  assert.deepEqual(await h.refresh([detail]), { attempted: 2, updated: 0, failed: 1 }); assert.equal(h.errors.length, 1);
});
test('property: valid batch identities preserve exact status observations across arbitrary positive IDs', async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 1, max: 10000000 }), { minLength: 1, maxLength: 20 }), async ids => {
    const h = harness({ fetchStatuses: async requested => requested.map(id => ({ id, tranid: `SO${id}`, status: 'F', status_text: sales.status_text })) });
    const inputs = ids.map(id => ({ salesOrderId: id, salesOrderRef: `SO${id}`, salesOrderStatusSyncedAt: old }));
    assert.equal((await h.refresh(inputs)).updated, ids.length);
    assert.equal(h.reads.length, 0);
    assert.deepEqual(h.writes.map(v => v.netsuiteOrderId), ids);
    assert.ok(h.writes.every(v => v.syncedAt === old && v.statusText === sales.status_text && v.status === 'F'));
  }), { seed: 20261005, numRuns: 100 });
});
test('property: fresh cache never fetches, even with duplicated cases', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 299999 }), fc.integer({ min: 1, max: 1000000 }), async (age, id) => {
    const h = harness(); const input = { salesOrderId: id, salesOrderRef: `SO${id}`, salesOrderStatusSyncedAt: new Date(now - age) };
    assert.deepEqual(await h.refresh([input, input]), { attempted: 0, updated: 0, failed: 0 }); assert.equal(h.reads.length, 0);
  }), { seed: 20261006, numRuns: 100 });
});
test('property: foreign references never change a cached order', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1000000 }), fc.string({ minLength: 1, maxLength: 20 }), async (id, suffix) => {
    const h = harness({ fetchStatuses: async () => [{ id, tranid: `FOREIGN-${suffix}`, status: 'F', status_text: sales.status_text }] });
    const result = await h.refresh([{ salesOrderId: id, salesOrderRef: `SO${id}`, salesOrderStatusSyncedAt: old }]);
    assert.equal(result.updated, 0); assert.equal(h.writes.length, 0);
  }), { seed: 20261007, numRuns: 100 });
});
test('property: canonical header always takes priority over the old linking snapshot', () => {
  fc.assert(fc.property(fc.constantFrom('A','B','C','D','E','F','G','H'), fc.string({ minLength: 1 }), (code, label) => {
    const fields = specialOrderStatusFields({ canonical_sales_status: code, canonical_sales_status_text: label, sales_order_status: `OLD-${label}` });
    assert.equal(fields.salesOrderStatus, label);
  }), { seed: 20261008, numRuns: 100 });
});
test('property: local delivery completion is independent of a complete NetSuite header', () => {
  fc.assert(fc.property(fc.boolean(), completed => {
    const html = specialPlanningStatus({ ...detail, operationallyComplete: completed }, false, { audience: 'sales' });
    assert.equal(html.includes('SO delivery: Delivered'), completed);
    assert.equal(html.includes('SO planning: Planned'), !completed);
  }), { seed: 20261009, numRuns: 100 });
});
test('queue polls visible active pages once per minute and disposes its timer', () => {
  const saved = { window: globalThis.window, document: globalThis.document, EventSource: globalThis.EventSource };
  const handlers = {}, intervals = [], cleared = []; let active = true, reads = 0, invalidations = 0;
  globalThis.EventSource = undefined;
  globalThis.window = { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 7; }, clearInterval: id => cleared.push(id),
    setTimeout: () => 1, clearTimeout: () => {}, addEventListener: (type, fn) => { handlers[type] = fn; } };
  globalThis.document = { hidden: false, addEventListener: () => {} };
  try {
    watchSpecialQueue({ queue: { invalidate: () => { invalidations++; }, load: async () => { reads++; } }, key: () => '', requests: () => [], active: () => active, audience: 'sales' });
    assert.equal(intervals.length, 1); assert.equal(intervals[0].ms, 60000);
    intervals[0].fn(); assert.equal(reads, 1); assert.equal(invalidations, 1);
    globalThis.document.hidden = true; intervals[0].fn(); assert.equal(reads, 1);
    globalThis.document.hidden = false; active = false; intervals[0].fn(); assert.equal(reads, 1);
    handlers.pagehide(); assert.deepEqual(cleared, [7]);
  } finally { Object.assign(globalThis, saved); }
});
test('native status labels escape markup and completed cards retain preview permissions', () => {
  const input = { ...detail, salesOrderStatus: '<img onerror="bad">', purchaseOrderStatus: '<script>bad</script>' };
  const html = specialPlanningStatus(input, false, { audience: 'sales', showOrderPreviews: true });
  assert.doesNotMatch(html, /NetSuite:|<img|<script/);
  assert.match(specialPlanningStatus(input,false,{audience:'scm',showOrderPreviews:true}),/NetSuite: &lt;img/);
  assert.match(html, /data-special-document="sales_order"/); assert.doesNotMatch(html, /data-special-document="purchase_order"/);
});
