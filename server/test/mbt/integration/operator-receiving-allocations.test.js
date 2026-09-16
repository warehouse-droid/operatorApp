import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { buildItemReceiptPayload, confirmReceivingLine, getReceivingOrder,
  getReceivableReceivingOrder } from "../../../src/receiving-repository.js";
import { createOperatorNetSuitePostingRealSourceResolver,
  createOperatorNetSuitePostingTargetResolver } from "../../../src/operator-netsuite-posting-targets.js";

after(closeDb);
const orderId = -891000001;
const sourceId = 891000002;

async function isolated(operation) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const rollback = await beginRollbackContext();
  try { return await rollback.run(operation); }
  finally { await rollback.rollback(); }
}

async function fixture({ quantity = 1234, received = 0, allocated = quantity,
  physical = [1, 2, 3, 4], conversions = [1000, 100, 10, 1], syntheticKey = false } = {}) {
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,destination_location_id,netsuite_active)
    VALUES($1,'ALLOCATED-SPLIT','B','Pending Receipt',1,true),($2,'ALLOCATED-PARENT','B','Pending Receipt',1,true)`, [orderId, sourceId]);
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,netsuite_active) VALUES($1,'ALLOCATED-SO',true)`, [sourceId]);
  const salesLine = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,quantity)
    VALUES($1,701,1001,$2) RETURNING id`, [sourceId, quantity])).rows[0].id;
  const ids = [];
  for (const id of [sourceId, orderId]) {
    const key = syntheticKey && id === orderId ? -891000003 : 701;
    const line = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
      item_type,quantity,unit,location_id,pallet_qty,layer_qty,section_qty,piece_qty,to_plt,to_lyr,to_sec,to_pcs,
      netsuite_received_qty,netsuite_received_baseline_qty,netsuite_active)
      VALUES($1,$2,1001,'ALLOCATED-PAVERS','ALLOCATED-PAVERS','InvtPart',$3,'PC',1,
        $4,$5,$6,$7,$8,$9,$10,$11,$12,$12,true) RETURNING id`,
    [id, key, quantity, ...physical, ...conversions, received])).rows[0].id;
    ids.push(line);
  }
  const [sourceLine, lineId] = ids;
  const split = (await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref)
    VALUES($1,'ALLOCATED-PARENT',$2,'ALLOCATED-SPLIT') RETURNING id`, [sourceId, orderId])).rows[0].id;
  await query(`INSERT INTO dispatch_scm_po_split_lines(split_id,source_line_id,split_line_id,sales_qty)
    VALUES($1,$2,$3,$4)`, [split, sourceLine, lineId, quantity]);
  await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
    po_order_id,po_order_ref,po_line_id,allocated_pallet_qty,allocated_layer_qty,allocated_section_qty,
    allocated_piece_qty,allocated_sales_qty,dispatch_target_ref,dispatch_target_line_key)
    VALUES($1,'ALLOCATED-SO',$2,$3,'ALLOCATED-SPLIT',$4,$5,$6,$7,$8,$9,'ALLOCATED-SO','ALLOCATED-SO::701')`,
  [sourceId, salesLine, orderId, lineId, ...physical, allocated]);
  return { lineId, split };
}

const physicalOf = line => [line.pallet_qty, line.layer_qty, line.section_qty, line.piece_qty].map(Number);
const allocations = async () => (await query("SELECT * FROM dispatch_so_po_allocations WHERE po_order_id=$1 ORDER BY id", [orderId])).rows;
const receipt = async () => {
  const order = await getReceivableReceivingOrder(orderId);
  return buildItemReceiptPayload(order, order.receivableLines).item.items.filter(item => item.itemReceive);
};

test("fully allocated PO retains every physical unit and the full Item Receipt quantity", () => isolated(async () => {
  const { lineId } = await fixture();
  const before = await allocations();
  const order = await getReceivingOrder(orderId);
  assert.equal(order.lines.length, 1);
  assert.equal(Number(order.lines[0].quantity), 1234);
  assert.deepEqual(physicalOf(order.lines[0]), [1, 2, 3, 4]);
  await confirmReceivingLine(orderId, lineId, { pallets: 1, layers: 2, sections: 3, pieces: 4 }, null);
  assert.deepEqual(await receipt(), [{ orderLine: 701, quantity: 1234, itemReceive: true, location: 1 }]);
  assert.deepEqual(await allocations(), before);
}));

test("partially received allocated PO shows and caps its actual remaining quantity", () => isolated(async () => {
  const { lineId } = await fixture({ quantity: 1234, received: 1100 });
  const order = await getReceivingOrder(orderId);
  assert.equal(order.lines.length, 1);
  assert.equal(Number(order.lines[0].quantity), 134);
  assert.deepEqual(physicalOf(order.lines[0]), [0, 1, 3, 4]);
  await confirmReceivingLine(orderId, lineId, { pallets: 999, layers: 999, sections: 999, pieces: 999 }, null);
  assert.equal((await receipt())[0].quantity, 134);
}));

test("overallocated sales-only PO receives its 1140 PC rather than the 1320 PC allocation", () => isolated(async () => {
  const { lineId } = await fixture({ quantity: 1140, allocated: 1320, physical: [0, 0, 0, 0], conversions: [0, 0, 0, 0] });
  const before = await allocations();
  assert.equal(Number((await getReceivingOrder(orderId)).lines[0]?.quantity), 1140);
  await confirmReceivingLine(orderId, lineId, { salesQty: 1320 }, null);
  assert.equal((await receipt())[0].quantity, 1140);
  assert.deepEqual(await allocations(), before);
}));

function sourceResolver(quantity) {
  return createOperatorNetSuitePostingRealSourceResolver({ query,
    fetchLiveSource: async identity => {
      assert.equal(identity.sourceOrderKind, "PO");
      assert.equal(identity.sourceNetSuiteId, sourceId);
      return { lines: [{ sourceLineKey: "701", sourceLineAliases: ["701"], restOrderLine: 3,
        identityStatus: "exact", quantity, completedQuantity: 0, remainingQuantity: quantity,
        location: 1, linkedTransactions: [] }] };
    } });
}

for (const syntheticKey of [false, true]) {
  test(`split PO Item Receipt resolves its positive PO parent and ${syntheticKey ? "synthetic" : "retained"} source line`, () => isolated(async () => {
    const { lineId, split } = await fixture({ syntheticKey });
    const resolveRealSource = sourceResolver(1234);
    const source = await resolveRealSource(await getReceivingOrder(orderId), { functionKey: "receiving" });
    assert.equal(source?.sourceOrderKind, "PO");
    assert.equal(source?.sourceNetSuiteId, sourceId);
    await confirmReceivingLine(orderId, lineId, { pallets: 1, layers: 2, sections: 3, pieces: 4 }, null);
    const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => null,
      getReceivableReceivingOrder, resolveRealSource });
    const target = await resolve({ functionKey: "receiving", orderId, clientLocationId: 1 });
    assert.equal(target.transactionType, "IR");
    assert.equal(target.targets[0].sourceNetSuiteId, sourceId);
    assert.deepEqual(target.targets[0].selectedLines.map(({ orderLine, quantity, location }) =>
      ({ orderLine, quantity, location })), [{ orderLine: 3, quantity: 1234, location: 1 }]);
    await query("UPDATE dispatch_scm_po_splits SET status='cancelled' WHERE id=$1", [split]);
    assert.equal(await resolveRealSource(await getReceivingOrder(orderId), { functionKey: "receiving" }), null);
  }));
}

test("split PO with missing line lineage cannot prepare a receipt", () => isolated(async () => {
  const { split } = await fixture({ allocated: 0 });
  await query("DELETE FROM dispatch_scm_po_split_lines WHERE split_id=$1", [split]);
  await assert.rejects(sourceResolver(1234)(await getReceivingOrder(orderId), { functionKey: "receiving" }),
    { code: "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED" });
}));

test("property: allocation never changes unreceived PO availability or receipt bounds", async () => {
  await fc.assert(fc.asyncProperty(fc.tuple(...Array.from({ length: 4 }, () => fc.integer({ min: 1, max: 8 }))),
    fc.integer({ min: 0, max: 150 }), fc.integer({ min: 0, max: 200 }), fc.boolean(),
    async (physical, receivedPercent, allocationPercent, salesOnly) => isolated(async () => {
      const total = physical.reduce((sum, value, index) => sum + value * [1000, 100, 10, 1][index], 0);
      const quantity = salesOnly ? total / 100 : total;
      const received = Math.round(quantity * receivedPercent / 100 * 1e6) / 1e6;
      const remaining = Math.max(quantity - received, 0);
      const { lineId } = await fixture({ quantity, received, allocated: quantity * allocationPercent / 100, syntheticKey: salesOnly,
        physical: salesOnly ? [0, 0, 0, 0] : physical, conversions: salesOnly ? [0, 0, 0, 0] : [1000, 100, 10, 1] });
      const before = await allocations();
      const order = await getReceivingOrder(orderId);
      assert.equal(order.lines.length, remaining > 0 ? 1 : 0);
      if (remaining <= 0) {
        await assert.rejects(getReceivableReceivingOrder(orderId), /No confirmed lines to receive/);
      } else {
        assert.ok(Math.abs(Number(order.lines[0].quantity) - remaining) < 0.000001);
        if (!salesOnly && received === 0) { assert.deepEqual(physicalOf(order.lines[0]), physical); }
        const [pallets, layers, sections, pieces] = physicalOf(order.lines[0]);
        await confirmReceivingLine(orderId, lineId, salesOnly ? { salesQty: remaining } : { pallets, layers, sections, pieces }, null);
        const expected = salesOnly ? Math.round(remaining * 1e6) / 1e6 : Math.floor(remaining + 0.000001);
        assert.equal((await receipt())[0].quantity, expected);
        const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => null,
          getReceivableReceivingOrder, resolveRealSource: sourceResolver(quantity) });
        const target = await resolve({ functionKey: "receiving", orderId, clientLocationId: 1 });
        assert.equal(target.transactionType, "IR");
        assert.equal(target.targets[0].sourceNetSuiteId, sourceId);
        assert.equal(target.targets[0].selectedLines[0].orderLine, 3);
        assert.equal(target.targets[0].selectedLines[0].quantity, expected);
      }
      assert.deepEqual(await allocations(), before);
    })), { seed: 20260915, numRuns: 80 });
});
