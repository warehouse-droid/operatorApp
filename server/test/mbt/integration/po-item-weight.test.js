import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { query, closeDb, pool, withTransaction } from '../../../src/db.js';
import { upsertInventoryBalances, upsertInventoryBalancesBulk } from '../../../src/inventory-repository.js';
import { applyPurchaseOrderItemWeights, enqueuePurchaseOrderWeightRefreshes } from '../../../src/purchase-order-weight-refresh.js';
import { createScmPurchaseOrderSplit, listScmPurchaseOrders } from '../../../src/dispatch-repository.js';

after(closeDb);
async function fixture() {
  const id = 9_810_000_000 + crypto.randomInt(1_000_000);
  const ref = `POB-WEIGHT-${id}`;
  await query(`INSERT INTO purchase_orders (netsuite_id,tranid,vendor,status,status_text,trandate,
    destination_location_id,destination_location,netsuite_active,initial_scm_status)
    VALUES ($1,$2,'Weight test','B','Purchase Order : Pending Receipt',current_date,1,'3445',true,'Queued')`, [id, ref]);
  const row = (await query(`INSERT INTO purchase_order_lines (purchase_order_id,line_id,item_id,item_name,sku,item_type,
    quantity,unit,item_weight,pallet_qty,to_plt,to_pcs,location_id,location,netsuite_received_qty,
    netsuite_received_baseline_qty,received_pallet_qty,netsuite_active,raw)
    VALUES ($1,$2,$3,'UNI-TV80S-RDM-STORM','UNI-TV80S-RDM-STORM','InvtPart',6038.4,'SQFT',26.08,
    74,81.6,1,1,'3445',0,0,0,true,'{"original":"source evidence"}'::jsonb) RETURNING *`, [id, id + 1, id + 2])).rows[0];
  const inventory = { item_id: id + 2, item_name: row.item_name, item_weight: 36.6459, stock_unit: 'SQFT',
    location_id: 1, location: '3445', quantity_on_hand: 7000, quantity_available: 6500, to_plt: 81.6, to_pcs: 1 };
  const fresh = [{ line_id: id + 1, item_id: id + 2, item_weight: '36.6459', quantity: 1 }];
  return { id, ref, row, inventory, fresh };
}
const readLine = id => query('SELECT * FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id', [id]).then(result => result.rows[0]);
const withoutWeight = ({ item_weight: _weight, ...rest }) => rest;

for (const [name, sync] of [['ordinary', upsertInventoryBalances], ['bulk', upsertInventoryBalancesBulk]]) {
  test(`PO weights DB: ${name} inventory sync detects drift, coalesces jobs, and avoids unnecessary work`, async () => {
    await withTransaction(async () => {
      const f = await fixture();
      await sync([f.inventory]);
      const jobs = () => query('SELECT * FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id=$1', [f.id]);
      assert.equal((await jobs()).rowCount, 1);
      assert.equal((await jobs()).rows[0].order_type, 'purchase_order');
      await sync([f.inventory, { ...f.inventory, location_id: 15 }]);
      assert.equal((await jobs()).rowCount, 1);
      assert.equal(Number((await readLine(f.id)).item_weight), 26.08, 'sync queues instead of taking PO line locks');
      await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: f.fresh });
      await query('DELETE FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id=$1', [f.id]);
      await sync([f.inventory]);
      assert.equal((await jobs()).rowCount, 0);
    }, { rollback: true });
  });
}

test('PO weights DB: correction preserves all other fields, recalculates PO/split weights and is idempotent', async () => {
  await withTransaction(async () => {
    const f = await fixture();
    await createScmPurchaseOrderSplit({ sourcePoRef: f.ref, newPoRef: `${f.ref}-S1`, destinationLocationId: 1,
      lines: [{ lineRowId: Number(f.row.id), pallets: 2 }], createdBy: 'weight-regression' });
    const before = await readLine(f.id);
    const splits = () => query('SELECT * FROM dispatch_scm_po_split_lines WHERE source_line_id=$1 ORDER BY id', [f.row.id]);
    const splitsBefore = (await splits()).rows;
    const childBefore = (await query('SELECT * FROM purchase_order_lines WHERE id=$1', [splitsBefore[0].split_line_id])).rows[0];
    const result = await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: f.fresh });
    assert.equal(result.updated, 2);
    const afterLine = await readLine(f.id);
    assert.equal(Number(afterLine.item_weight), 36.6459);
    assert.deepEqual(withoutWeight(afterLine), withoutWeight(before));
    assert.deepEqual((await splits()).rows, splitsBefore);
    const childAfter = (await query('SELECT * FROM purchase_order_lines WHERE id=$1', [childBefore.id])).rows[0];
    assert.deepEqual(withoutWeight(childAfter), withoutWeight(childBefore));
    const orders = await listScmPurchaseOrders({ search: f.ref, includeAllDiscoverable: true });
    const split = orders.find(order => order.id === `${f.ref}-S1`);
    assert.ok(split);
    assert.ok(Math.abs(split.weight - (2 * 81.6 * 36.6459)) < 0.01);
    assert.equal(Number(split.items[0].itemWeight), 36.6459);
    const parent = orders.find(order => order.id === f.ref);
    assert.ok(Math.abs(parent.weight - ((6038.4 - 2 * 81.6) * 36.6459)) < 0.01);
    assert.equal((await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: f.fresh })).updated, 0);
    const audits = await query("SELECT details FROM delivery_audit_log WHERE order_id=$1 AND action='netsuite.purchase_order.item_weight_refresh'", [f.id]);
    assert.equal(audits.rowCount, 1);
    assert.equal(audits.rows[0].details.changes[0].previous_weight, '26.08');
  }, { rollback: true });
});

test('PO weights DB: drift in a split queues its NetSuite parent even when the parent weight is current', async () => {
  await withTransaction(async () => {
    const f = await fixture();
    await createScmPurchaseOrderSplit({ sourcePoRef: f.ref, newPoRef: `${f.ref}-S1`, destinationLocationId: 1,
      lines: [{ lineRowId: Number(f.row.id), pallets: 2 }], createdBy: 'weight-regression' });
    await query('UPDATE purchase_order_lines SET item_weight=36.6459 WHERE purchase_order_id=$1', [f.id]);
    await upsertInventoryBalancesBulk([f.inventory]);
    const jobs = (await query('SELECT netsuite_order_id FROM netsuite_delayed_status_refresh_jobs WHERE tranid=$1', [f.ref])).rows;
    assert.deepEqual(jobs, [{ netsuite_order_id: String(f.id) }]);
    assert.equal((await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: f.fresh })).updated, 1);
    const catalog = await query("SELECT order_ref FROM scm_purchase_order_catalog_refresh_outbox WHERE source='po-item-weight-refresh'");
    assert.ok(catalog.rows.some(row => row.order_ref === `${f.ref}-S1`));
  }, { rollback: true });
});

test('PO weights DB: identity/active scope protects unrelated rows and null/zero clear stale weights', async () => {
  await withTransaction(async () => {
    const f = await fixture();
    for (const patch of [{ item_id: f.id + 3 }, { line_id: f.id + 3 }]) {
      assert.equal((await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: [{ ...f.fresh[0], ...patch }] })).updated, 0);
    }
    assert.equal((await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id + 1, lines: f.fresh })).updated, 0);
    await query('UPDATE purchase_order_lines SET netsuite_active=false WHERE purchase_order_id=$1', [f.id]);
    assert.equal((await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: f.fresh })).updated, 0);
    await query('UPDATE purchase_order_lines SET netsuite_active=true WHERE purchase_order_id=$1', [f.id]);
    for (const weight of [0, null]) {
      await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: [{ ...f.fresh[0], item_weight: weight }] });
      assert.equal((await readLine(f.id)).item_weight, weight === null ? null : '0');
    }
    await assert.rejects(() => applyPurchaseOrderItemWeights({ netsuiteOrderId: 0, lines: f.fresh }), /identity/i);
    assert.equal((await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: [] })).updated, 0);
  }, { rollback: true });
});

test('PO weights DB: detection excludes inactive orders/lines, unrelated items, and rolls back with sync', async () => {
  await withTransaction(async () => {
    const f = await fixture();
    await withTransaction(() => upsertInventoryBalancesBulk([f.inventory]), { rollback: true });
    assert.equal((await query('SELECT id FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id=$1', [f.id])).rowCount, 0);
    await query('UPDATE purchase_orders SET netsuite_active=false WHERE netsuite_id=$1', [f.id]);
    await upsertInventoryBalancesBulk([f.inventory]);
    assert.equal((await enqueuePurchaseOrderWeightRefreshes([f.id + 2])).queued, 0);
    await query('UPDATE purchase_orders SET netsuite_active=true WHERE netsuite_id=$1', [f.id]);
    await query('UPDATE purchase_order_lines SET netsuite_active=false WHERE purchase_order_id=$1', [f.id]);
    assert.equal((await enqueuePurchaseOrderWeightRefreshes([f.id + 2])).queued, 0);
    await query('UPDATE purchase_order_lines SET netsuite_active=true WHERE purchase_order_id=$1', [f.id]);
    assert.equal((await enqueuePurchaseOrderWeightRefreshes([f.id + 3])).queued, 0);
    assert.equal((await enqueuePurchaseOrderWeightRefreshes([null, 'bad', -1, 0])).queued, 0);
    assert.equal((await enqueuePurchaseOrderWeightRefreshes([f.id + 2, f.id + 2])).queued, 1);
  }, { rollback: true });
});

test('PO weights DB: failed transaction rolls back correction and audit while retaining quantity edits', async () => {
  await withTransaction(async () => {
    const f = await fixture();
    await query('UPDATE purchase_order_lines SET quantity=7000,received_pallet_qty=3 WHERE purchase_order_id=$1', [f.id]);
    const before = await readLine(f.id);
    await assert.rejects(() => withTransaction(async () => {
      await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: f.fresh });
      throw new Error('simulated job finalization failure');
    }), /simulated/);
    assert.deepEqual(await readLine(f.id), before);
    assert.equal((await query("SELECT id FROM delivery_audit_log WHERE order_id=$1 AND action='netsuite.purchase_order.item_weight_refresh'", [f.id])).rowCount, 0);
    await applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: f.fresh });
    assert.deepEqual(withoutWeight(await readLine(f.id)), withoutWeight(before));
  }, { rollback: true });
});

test('PO weights DB: an item changed while the correction waits on a lock never receives the old item weight', async () => {
  const f = await fixture();
  const locker = await pool.connect();
  let correction;
  try {
    await locker.query('BEGIN');
    await locker.query('UPDATE purchase_order_lines SET item_id=$2 WHERE id=$1', [f.row.id, f.id + 3]);
    correction = applyPurchaseOrderItemWeights({ netsuiteOrderId: f.id, lines: f.fresh });
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      const state = await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'WITH RECURSIVE targets AS%'");
      waiting = state.rowCount > 0;
      if (!waiting) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.equal(waiting, true, 'correction must be blocked behind the concurrent edit');
    await locker.query('COMMIT');
    assert.equal((await correction).updated, 0);
    const line = await readLine(f.id);
    assert.equal(Number(line.item_id), f.id + 3);
    assert.equal(Number(line.item_weight), 26.08);
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
    if (correction) {
      await correction.catch(() => {});
    }
    await query('DELETE FROM purchase_orders WHERE netsuite_id=$1', [f.id]);
  }
});
