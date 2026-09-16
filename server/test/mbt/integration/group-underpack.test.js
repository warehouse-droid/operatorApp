import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, closeDb, withTransaction } from "../../../src/db.js";
import { getDeliveryOrder, getDeliveryOrdersBatch, listDeliveryOrders, recordDeliveryLoad, confirmDeliveryLine } from "../../../src/delivery-repository.js";
import { packingOrder, packingGroup, packingState } from "../../support/group-underpack-fixture.mjs";

after(closeDb);
const scenario = run => withTransaction(run, { rollback: true });

async function assertProgress(order, groupId, underpack) {
  const detail = await getDeliveryOrder(order.id), group = await getDeliveryOrder(groupId);
  assert.equal(detail.underpack_count, underpack, `${order.ref} detail`);
  assert.equal(group.underpack_count, underpack, `${groupId} detail`);
  return group;
}

test("reported five packed lines show Packed in grouped detail, batch and both lists", async () => scenario(async () => {
  const order = await packingOrder({ ref: "SOB120124" });
  const pallet = await packingOrder({ ref: "SOB120358", quantity: 13, salesOnly: true, packed: 13 });
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,location_id,location,
    pallet_qty,layer_qty,to_plt,to_lyr,packed_pallet_qty,packed_layer_qty,netsuite_active)
    VALUES($1,2,2296,'UNI-BH80S-RDM-FOS','UNI-BH80S-RDM-FOS','InvtPart',652.8,'SQFT',1,'3445',8,0,81.6,11.66,8,0,true),
    ($1,3,2167,'UNI-BH80S-0715-MC','UNI-BH80S-0715-MC','InvtPart',128.24,'SQFT',1,'3445',1,4,81.6,11.66,1,4,true),
    ($1,4,2294,'UNI-BH60S-RDM-FOS','UNI-BH60S-RDM-FOS','InvtPart',151.55,'SQFT',1,'3445',1,4,104.91,11.66,1,4,true)`, [order.id]);
  const groupId = await packingGroup([order, pallet]);
  const before = await packingState(order);
  const detail = await assertProgress(order, groupId, 0);
  assert.equal(detail.operator_status, "packed"); assert.equal(detail.lines.length, 5);
  assert.equal((await getDeliveryOrder(pallet.id)).underpack_count, 0);
  const batch = await getDeliveryOrdersBatch([groupId]);
  assert.equal(batch[0].underpack_count, 0);
  const packed = (await listDeliveryOrders({ locationId: 1, status: "packed" })).find(row => row.netsuite_id === groupId);
  assert(packed); assert.equal(packed.underpack_count, 0); assert.equal(packed.operator_status, "packed");
  assert(!(await listDeliveryOrders({ locationId: 1 })).some(row => row.netsuite_id === groupId));
  assert.deepEqual(await packingState(order), before);
}));

test("SO and TO standalone and group lists close converted rounding remainders after partial loading", async () => scenario(async () => {
  for (const transfer of [false, true]) {
    const order = await packingOrder({ transfer, quantity: 186.52, layers: 16, packed: 8, loaded: 93.26 });
    const options = { locationId: 1, orderType: transfer ? "transfer_order" : "sales_order" };
    assert.equal((await getDeliveryOrder(order.id)).underpack_count, 0);
    assert.equal((await listDeliveryOrders({ ...options, status: "packed" })).find(row => String(row.netsuite_id) === String(order.id))?.underpack_count, 0);
    assert(!(await listDeliveryOrders(options)).some(row => String(row.netsuite_id) === String(order.id)));
    const groupId = await packingGroup([order]);
    await assertProgress(order, groupId, 0);
    assert.equal((await listDeliveryOrders({ ...options, status: "packed" })).find(row => row.netsuite_id === groupId)?.underpack_count, 0);
  }
}));

test("actual missing packages, sales-only fractions, unpacked lines and larger differences remain underpacked", async () => scenario(async () => {
  for (const values of [
    { packed: 7 },
    { quantity: 93.356001 },
    { quantity: 0.15, layers: 3, conversion: 0.05, packed: 2 },
    { quantity: 0.004, layers: 1, conversion: 0.004, packed: 0 },
    { quantity: 13.004, salesOnly: true, packed: 13 }
  ]) {
    const order = await packingOrder(values), complete = await packingOrder({ quantity: 20, layers: 1, conversion: 20, packed: 1 });
    const group = await packingGroup([order, complete]);
    assert.equal((await getDeliveryOrder(group)).underpack_count, 1, JSON.stringify(values));
    const active = (await listDeliveryOrders({ locationId: 1 })).find(row => row.netsuite_id === group);
    assert.equal(active?.underpack_count, 1, JSON.stringify(values));
  }
}));

test("overpacked group member cannot hide another member's real shortage", async () => scenario(async () => {
  const short = await packingOrder({ packed: 7 }), excess = await packingOrder({ packed: 9 });
  const group = await packingGroup([short, excess]);
  assert.equal((await getDeliveryOrder(group)).underpack_count, 1);
}));

test("loading eight whole layers closes the exact rounded sales quantity for SO and TO", async () => scenario(async () => {
  for (const transfer of [false, true]) {
    const order = await packingOrder({ transfer });
    const result = await recordDeliveryLoad(order.id, null, { photoDataUrls: ["data:image/png;base64,dGVzdDE=", "data:image/png;base64,dGVzdDI="] });
    assert.equal(result.localYardOrderStatus, "Loaded"); assert.equal(result.remainingLines, 0);
    const detail = await getDeliveryOrder(order.id);
    assert.equal(detail.operator_status, "loaded"); assert.equal(detail.underpack_count, 0);
    assert.equal(Number(detail.lines[0].loaded_qty), 93.26);
    assert.equal(Number(detail.lines[0].packed_layer_qty), 0);
  }
}));

test("exact 0.1 rounding boundary closes loaded sales quantities for SO and TO", async () => scenario(async () => {
  for (const transfer of [false, true]) {
    for (const values of [{ quantity: 93.356 }, { quantity: 1.1, layers: 1, packed: 1, conversion: 1 },
      { quantity: 0.7, layers: 1, packed: 1, conversion: 0.8 }]) {
      const order = await packingOrder({ transfer, ...values });
      const result = await recordDeliveryLoad(order.id, null, { photoDataUrls: ["data:image/png;base64,dGVzdDE=", "data:image/png;base64,dGVzdDI="] });
      assert.equal(result.remainingLines, 0);
      assert.equal(result.localYardOrderStatus, "Loaded");
      assert.equal(Number((await getDeliveryOrder(order.id)).lines[0].loaded_qty), values.quantity);
    }
  }
}));

test("overpacking beyond the rounding tolerance remains blocked without changing quantities", async () => scenario(async () => {
  const order = await packingOrder({ quantity: 0.699999, layers: 1, packed: 1, conversion: 0.8 });
  const before = await packingState(order);
  await assert.rejects(recordDeliveryLoad(order.id, null, { photoDataUrls: ["data:image/png;base64,dGVzdDE=", "data:image/png;base64,dGVzdDI="] }),
    { code: "DELIVERY_LOAD_VALIDATION_FAILED" });
  assert.deepEqual(await packingState(order), before);
}));

test("confirmation derives eight layers at the exact conversion boundary", async () => scenario(async () => {
  const actor = "packing-rounding-actor";
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,'Packing test','test','test','operator',ARRAY['operator'],true)", [actor]);
  for (const [quantity, layers, conversion] of [[93.156, 8, 11.657], [1.9, 2, 1]]) {
    const order = await packingOrder({ quantity, conversion, layers: 0, packed: 0 });
    await confirmDeliveryLine(order.id, order.lineId, { layers }, actor);
    assert.equal(Number((await getDeliveryOrder(order.id)).lines[0].packed_layer_qty), layers);
  }
}));

test("property: integer oracle preserves real shortages and closes only converted rounding in SQL and groups", async () => scenario(async () => {
  const order = await packingOrder(), group = await packingGroup([order]);
  const cases = fc.record({ conversionTicks: fc.constantFrom(0, 1, 4, 50, 100, 11657, 81600),
    packages: fc.integer({ min: 1, max: 50 }), missingTicks: fc.constantFrom(-4, 0, 1, 4, 99, 100, 101, 200),
    loadedTicks: fc.integer({ min: 0, max: 10000 }) });
  await fc.assert(fc.asyncProperty(cases, async ({ conversionTicks, packages, missingTicks, loadedTicks }) => {
    const packedTicks = conversionTicks ? conversionTicks * packages : packages * 1000;
    const requiredTicks = Math.max(1, packedTicks + loadedTicks + missingTicks);
    const residualTicks = requiredTicks - loadedTicks - packedTicks;
    const expected = residualTicks <= 0 || (conversionTicks > 0 && residualTicks <= 100 && residualTicks < conversionTicks) ? 0 : 1;
    await query(`UPDATE sales_order_lines SET quantity=$2,layer_qty=$3,to_lyr=$4,packed_layer_qty=$5,packed_sales_qty=$6,loaded_qty=$7 WHERE id=$1`,
      [order.lineId, requiredTicks / 1000, conversionTicks ? packages : 0, conversionTicks / 1000,
        conversionTicks ? packages : 0, conversionTicks ? 0 : packages, loadedTicks / 1000]);
    await assertProgress(order, group, expected);
  }), { seed: 20260915, numRuns: 160,
    examples: [[{ conversionTicks: 11657, packages: 8, missingTicks: 4, loadedTicks: 0 }],
      [{ conversionTicks: 11657, packages: 8, missingTicks: 100, loadedTicks: 0 }],
      [{ conversionTicks: 50, packages: 2, missingTicks: 50, loadedTicks: 0 }],
      [{ conversionTicks: 0, packages: 2, missingTicks: 4, loadedTicks: 0 }]] });
}));
