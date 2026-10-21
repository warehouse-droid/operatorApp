/* global structuredClone */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { query, closeDb, pool } from '../../../src/db.js';
import { createDispatchPlan, saveDispatchPlanSnapshot } from '../../../src/dispatch-plan-repository.js';
import { applyDispatchV2Command } from '../../../src/dispatch-planner-v2-repository.js';
import { syncDispatchGlobalOrderSplitsFromPlan } from '../../../src/dispatch-delivery-group-repository.js';
import { getDispatchSplitPreview } from '../../../src/dispatch-split-preview-repository.js';
import { seedSalesOrder, scenario } from '../support/fulfilled-so-fixture.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../../../src/dispatch-fleet-status.js';

after(closeDb);
const code = { code: 'DISPATCH_SPLIT_QUANTITY_MISMATCH', status: 409 };
async function fixture(values = [1860, 2356]) {
  const id = 17_000_000_000 + Number.parseInt(crypto.randomBytes(4).toString('hex'), 16);
  const ref = `SO-QUANTITY-${id}`;
  await seedSalesOrder(id, ref, { status: 'B' });
  await query(`UPDATE sales_order_lines SET quantity=8432,unit='SQFT',item_type='NonInvtPart',
    pallet_qty=136,to_plt=0,to_lyr=0,to_sec=0,to_pcs=0 WHERE sales_order_id=$1`, [id]);
  const source = { ...await getDispatchSplitPreview({ orderRef: ref, type: 'SO' }),
    sourceTable: 'sales_orders', customer: 'Quantity fixture', sourceYard: '3445',
    pickupLocations: ['3445'], address: 'Isolated Test Road', destinationAddress: 'Isolated Test Road',
    netsuiteId: String(id), salesQty: 8432 };
  const parts = values.map((quantity, index) => ({ ...source, id: `${ref}-S${index + 1}`,
    originalOrderId: ref, netsuiteId: '', planOwned: true, salesQty: quantity,
    items: source.items.map(item => ({ ...item, quantity, pallets: 0, splitQty: quantity })) }));
  const plan = await createDispatchPlan({ planDate: '2099-10-20' });
  return { id, ref, source, parts, plan };
}
async function state(f) {
  return {
    plan: (await query('SELECT to_jsonb(p) AS data FROM dispatch_plans p WHERE id=$1', [f.plan.id])).rows,
    snapshot: (await query('SELECT to_jsonb(s) AS data FROM dispatch_plan_snapshots s WHERE plan_id=$1', [f.plan.id])).rows,
    splits: (await query('SELECT to_jsonb(s) AS data FROM dispatch_global_order_splits s WHERE parent_order_ref=$1 ORDER BY split_ref', [f.ref])).rows,
    receipts: (await query('SELECT to_jsonb(c) AS data FROM dispatch_plan_commands c WHERE plan_id=$1', [f.plan.id])).rows
  };
}
function save(f, path = 'legacy') {
  const payload = { orders: f.parts, trucks: [], summary: {}, planDate: f.plan.planDate };
  return path === 'legacy' ? saveDispatchPlanSnapshot(f.plan.id, payload)
    : applyDispatchV2Command({ planId: f.plan.id, command: {
      commandId: crypto.randomUUID(), commandType: 'replace_plan', baseRevision: f.plan.revision, payload } });
}
for (const path of ['legacy', 'v2']) {
  for (const [label, values] of [['short', [1860, 2356]], ['excess', [1860, 6573]]]) {
    test(`${path} rejects ${label} split atomically using authoritative 8432 SQFT`, () => scenario(async () => {
      const f = await fixture(values), before = await state(f);
      await assert.rejects(save(f, path), code);
      assert.deepEqual(await state(f), before);
    }));
  }
  test(`${path} accepts a complete balanced family`, () => scenario(async () => {
    const f = await fixture([1860, 6572]);
    await save(f, path);
    const rows = (await query(`SELECT full_order FROM dispatch_global_order_splits WHERE parent_order_ref=$1 AND active`, [f.ref])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.full_order.items[0].quantity), 0), 8432);
  }));
}

test('retained siblings count toward the family; a changed or omitted line cannot hide the difference', () => scenario(async () => {
  const f = await fixture([1860, 6572]);
  await syncDispatchGlobalOrderSplitsFromPlan({ ...f.plan, orders: f.parts, trucks: [] });
  f.parts = [structuredClone(f.parts[1])];
  f.parts[0].items[0].quantity = 372;
  const before = await state(f);
  await assert.rejects(save(f), code);
  assert.deepEqual(await state(f), before);
}));

test('unchanged historical short splits remain usable without rewriting their quantities', () => scenario(async () => {
  const f = await fixture();
  await syncDispatchGlobalOrderSplitsFromPlan({ ...f.plan, orders: f.parts, trucks: [] });
  await save(f);
  const rows = (await query('SELECT full_order FROM dispatch_global_order_splits WHERE parent_order_ref=$1', [f.ref])).rows;
  assert.equal(rows.reduce((sum, row) => sum + Number(row.full_order.items[0].quantity), 0), 4216);
}));

test('forged parent totals, duplicated child references and grouped children cannot bypass validation', () => scenario(async () => {
  const f = await fixture();
  for (const part of f.parts) {
    part.raw = { total_quantity: 4216, items: [{ ...part.items[0], quantity: 4216 }] };
    part.salesQuantities = [{ unit: 'SQFT', quantity: 4216 }];
  }
  await assert.rejects(save(f), code);
  const group = { id: `GOA-${f.id}`, type: 'SO', childOrders: f.parts.map(p => p.id), childOrderDetails: f.parts, items: [] };
  f.parts = [group];
  await assert.rejects(save(f), code);
}));

test('source quantities are rechecked after waiting for the fleet lock', async () => {
  const f = await fixture([1860, 6572]), client = await pool.connect();
  let pending;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    pending = save(f);
    const rejection = assert.rejects(pending, code);
    await client.query('SELECT pg_sleep(0.1)');
    await client.query('UPDATE sales_order_lines SET quantity=8500 WHERE sales_order_id=$1', [f.id]);
    await client.query('COMMIT');
    await rejection;
    assert.equal((await state(f)).splits.length, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pending?.catch(() => undefined);
  }
});

test('TO outbound lines with local row identities conserve quantities across both plan-save paths', () => scenario(async () => {
  for (const path of ['legacy', 'v2']) await scenario(async () => {
    const id = 25_000_000_000 + Number.parseInt(crypto.randomBytes(4).toString('hex'), 16);
    const ref = `TO-QUANTITY-${id}`;
    await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,
      from_location,to_location_id,to_location,outbound_operator_status,receiving_status,
      local_yard_order_status,fulfillment_status,netsuite_active)
      VALUES($1,$2,'B','Pending Fulfillment',15,'12441',1,'3445','open','not_received','Open','not_fulfilled',true)`, [id, ref]);
    const line = (await query(`INSERT INTO transfer_order_lines(line_stage,transfer_order_id,line_id,
      item_id,item_name,sku,quantity,unit,piece_qty,to_pcs,location_id,location,confirmed,netsuite_active)
      VALUES('outbound',$1,NULL,2055,'Quantity cargo','QUANTITY-TEST',100,'PC',100,1,15,'12441',false,true)
      RETURNING id`, [id])).rows[0];
    const source = { id: ref, type: 'TO', sourceTable: 'transfer_orders', customer: 'Quantity transfer',
      sourceYard: '12441', pickupLocations: ['12441'], address: '3445', destinationAddress: '3445',
      items: [{ lineId: null, lineRowId: line.id, itemId: 2055, sku: 'QUANTITY-TEST',
        quantity: 100, unit: 'PC', pieces: 100, toPcs: 1 }] };
    const f = { id, ref, source, plan: await createDispatchPlan({ planDate: '2099-10-23' }),
      parts: [40, 59].map((quantity, n) => ({ ...source, id: `${ref}-S${n + 1}`,
        originalOrderId: ref, planOwned: true, items: [{ ...source.items[0], quantity, pieces: quantity }] })) };
    const before = await state(f);
    await assert.rejects(save(f, path), code);
    assert.deepEqual(await state(f), before);
    Object.assign(f.parts[1].items[0], { quantity: 60, pieces: 60 });
    await save(f, path);
    assert.equal((await state(f)).splits.length, 2);
  });
}));

test('conflicting duplicates, mismatched parents, unavailable sources and excessive nesting fail without writing', () => scenario(async () => {
  for (const change of [
    f => { const other = structuredClone(f.parts[0]); other.items[0].quantity += 1; f.parts.push(other); },
    f => { f.parts[0].originalOrderId = 'SO-OTHER'; },
    async f => { await query('UPDATE sales_order_lines SET netsuite_active=false WHERE sales_order_id=$1', [f.id]); },
    f => { for (let n = 0; n < 22; n++) f.parts = [{ id: `GROUP-${n}`, childOrderDetails: f.parts }]; }
  ]) await scenario(async () => {
    const f = await fixture([1860, 6572]); await change(f);
    const before = await state(f);
    await assert.rejects(save(f), code);
    assert.deepEqual(await state(f), before);
  });
}));
