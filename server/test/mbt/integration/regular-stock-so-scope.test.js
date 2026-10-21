import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import {randomUUID} from 'node:crypto';
import fc from 'fast-check';
import {query, closeDb} from '../../../src/db.js';
import {submitDeliveryStockRequest, retryDeliveryStockRequest, decideDeliveryStockRequest} from '../../../src/regular-stock-delivery.js';

const actor = 'so-scope-' + randomUUID();
const itemId = 9800000000000 + parseInt(randomUUID().replaceAll('-', '').slice(0, 6), 16);
const baseId = parseInt(randomUUID().replaceAll('-', '').slice(0, 10), 16);
const context = {operatorId: actor, authorizedDestinationLocationIds: [1, 28, 15, 26]};
let sequence = 0;

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)", [actor]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'SELECTED-MATERIAL','PC',1,60)", [itemId]);
  for (const location of [1, 28, 15]) {
    await query('INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,100000000,100000000,now())', [itemId, location, String(location)]);
  }
});
after(closeDb);

function fixture(source = 1) {
  const id = baseId + (++sequence), ref = `SO-${actor}-${sequence}`;
  const selected = {remoteLineId: 11, restLineId: 1, itemId, itemName: 'SELECTED-MATERIAL', itemType: 'InvtPart', quantity: 24, restQuantity: 24, backorderedQuantity: 17, uom: 'PC', locationId: 28, open: true, ancillary: false};
  const order = {id, ref, customerId: 42, locationId: 28, lines: [selected, {...selected, remoteLineId: 22, restLineId: 2, itemId: itemId + 1, quantity: 5, restQuantity: 5, backorderedQuantity: 0}]};
  const calls = {confirm: 0, dependencies: 0};
  const dependencies = {
    liveExecutionEnabled: true,
    readOrder: async () => structuredClone(order),
    refreshAvailability: async () => {}, hydrateOrder: async () => {}, syncReplenishments: async () => {},
    linkTransferDependency: async (_request, handoff, transfer) => {
      calls.dependencies++;
      assert.deepEqual(handoff.plan.mappings.map(line => [line.remoteLineId, line.itemId, line.quantity]), [[11, itemId, 24]]);
      assert.deepEqual(transfer.lines.map(line => [line.itemId, line.salesQty]), [[itemId, 24]]);
    },
    confirmTransfer: async transfer => {
      calls.confirm++;
      await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1", [transfer.id, 9800000 + transfer.id, `TO-SCOPE-${transfer.id}`]);
    }
  };
  return {order, calls, dependencies, input: {sourceLocationId: source, destinationLocationId: 28, salesOrderRef: ref, selectedRemoteLineIds: [11]}};
}

const save = f => submitDeliveryStockRequest(f.input, context, {...f.dependencies, liveExecutionEnabled: false});
const retry = (f, saved) => retryDeliveryStockRequest(saved.id, context, f.dependencies);

async function assertSelectedTransfer(f, result) {
  assert.equal(result.regular.handoffStatus, 'complete', result.regular.handoffError);
  assert.equal(result.regular.handoffError, null);
  assert.equal(result.transfers.length, 1);
  assert.deepEqual(result.transfers[0].lines.map(line => [line.itemId, line.salesQty]), [[itemId, 24]]);
  assert.equal(f.calls.confirm, 1);
  assert.equal(f.calls.dependencies, 1);
  const owners = (await query('SELECT remote_line_id FROM regular_stock_so_line_owners WHERE request_id=$1', [result.id])).rows;
  assert.deepEqual(owners.map(row => Number(row.remote_line_id)), [11]);
}

const unrelatedChanges = {
  added: order => order.lines.push({...order.lines[1], remoteLineId: 33, restLineId: 3}),
  removed: order => order.lines.splice(1, 1),
  edited: order => Object.assign(order.lines[1], {quantity: 8, restQuantity: 8, uom: 'BOX', locationId: 15, backorderedQuantity: 2, open: false}),
  reordered: order => order.lines.reverse(),
  'same item added': order => order.lines.push({...order.lines[0], remoteLineId: 33, restLineId: 3})
};
for (const [name, change] of Object.entries(unrelatedChanges)) {
  test(`unselected SO line ${name} permits only the saved selected transfer`, async () => {
    const f = fixture(), saved = await save(f);
    change(f.order);
    await assertSelectedTransfer(f, await retry(f, saved));
  });
}

const selectedChanges = {
  item: line => { line.itemId++; },
  quantity: line => { line.quantity++; },
  'REST quantity': line => { line.restQuantity++; },
  unit: line => { line.uom = 'BOX'; },
  yard: line => { line.locationId = 1; },
  backorder: line => { line.backorderedQuantity--; },
  fulfilled: line => { line.open = false; },
  'recreated identity': line => { line.remoteLineId = 44; }
};
async function assertBlocked(f, saved) {
  const result = await retry(f, saved);
  assert.equal(result.regular.handoffStatus, 'attention');
  assert.match(result.regular.handoffError, /SO changed/);
  assert.equal(result.transfers.length, 0);
  assert.equal(f.calls.confirm, 0);
  assert.equal(f.calls.dependencies, 0);
}
for (const [name, change] of Object.entries(selectedChanges)) {
  test(`selected ${name} change still blocks before a transfer is created`, async () => {
    const f = fixture(), saved = await save(f);
    change(f.order.lines[0]);
    await assertBlocked(f, saved);
  });
}
test('removed selected line still blocks when an identical item remains elsewhere', async () => {
  const f = fixture(), saved = await save(f);
  f.order.lines = [{...f.order.lines[0], remoteLineId: 99, restLineId: 9}];
  await assertBlocked(f, saved);
});
for (const field of ['id', 'customerId', 'locationId']) {
  test(`SO header ${field} change still blocks`, async () => {
    const f = fixture(), saved = await save(f);
    f.order[field]++;
    await assertBlocked(f, saved);
  });
}
test('manual approval allows an unrelated new line and keeps the selected quantities', async () => {
  const f = fixture(15), saved = await save(f);
  unrelatedChanges.added(f.order);
  const result = await decideDeliveryStockRequest(saved.id, {decision: 'stock', expectedRevision: saved.revision}, context, f.dependencies);
  await assertSelectedTransfer(f, result);
});
test('retry with unrelated SO edits recovers the same committed transfer without duplication', async () => {
  const f = fixture(), confirm = f.dependencies.confirmTransfer;
  f.dependencies.confirmTransfer = async transfer => {
    await confirm(transfer);
    await query("UPDATE sales_stock_transfers SET confirmation_status='attention',status='attention' WHERE id=$1", [transfer.id]);
    throw new Error('Simulated transfer mirror failure after commitment');
  };
  const saved = await submitDeliveryStockRequest(f.input, context, f.dependencies);
  assert.equal(saved.regular.handoffStatus, 'attention');
  const existing = saved.transfers[0];
  unrelatedChanges.added(f.order);
  f.dependencies.confirmTransfer = async transfer => {
    assert.equal(transfer.id, existing.id);
    assert.equal(transfer.netsuiteTransferOrderId, existing.netsuiteTransferOrderId);
    await query("UPDATE sales_stock_transfers SET confirmation_status='complete',status='pending_fulfillment' WHERE id=$1", [transfer.id]);
  };
  const done = await retry(f, saved);
  await assertSelectedTransfer(f, done);
  assert.equal(done.transfers[0].id, existing.id);
  assert.equal(done.transfers[0].netsuiteTransferOrderId, existing.netsuiteTransferOrderId);
  await retry(f, done);
  assert.equal(f.calls.confirm, 1);
});
test('non-Delivery handoffs retain whole-order change validation', async () => {
  const f = fixture(), saved = await save(f);
  await query("UPDATE regular_stock_handoffs SET plan=plan||'{\"delivery\":false}'::jsonb WHERE request_id=$1", [saved.id]);
  unrelatedChanges.added(f.order);
  await assertBlocked(f, saved);
});
test('property: arbitrary unselected edits cannot block or expand a saved transfer', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({quantity: fc.integer({min: 1, max: 500}), open: fc.boolean(), yard: fc.constantFrom(1, 15, 28), sameItem: fc.boolean()}), {maxLength: 8}),
    fc.boolean(),
    async (others, reverse) => {
      const f = fixture(), saved = await save(f);
      const selected = f.order.lines[0];
      f.order.lines = [selected, ...others.map((other, index) => ({...selected, remoteLineId: 100 + index, restLineId: 10 + index, itemId: other.sameItem ? itemId : itemId + index + 1, quantity: other.quantity, restQuantity: other.quantity, backorderedQuantity: 0, open: other.open, locationId: other.yard}))];
      if (reverse) { f.order.lines.reverse(); }
      await assertSelectedTransfer(f, await retry(f, saved));
    }
  ), {seed: 1052026, numRuns: 30});
});
test('property: selected changes remain blocked regardless of unrelated edits', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(...Object.keys(selectedChanges), 'header customer'), fc.integer({min: 1, max: 500}), async (field, quantity) => {
    const f = fixture(), saved = await save(f);
    if (field === 'header customer') { f.order.customerId++; }
    else { selectedChanges[field](f.order.lines[0]); }
    f.order.lines[1].quantity = quantity;
    await assertBlocked(f, saved);
  }), {seed: 1052027, numRuns: 30});
});
