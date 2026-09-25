import assert from "node:assert/strict";
import test, { after } from "node:test";
import { query, withTransaction, closeDb } from "../../src/db.js";
import { getDeliveryOrder, listDeliveryOrders, validateConsolidatedDeliveryOrder } from "../../src/delivery-repository.js";
import { upsertLocalCoOrder, getLocalCoOrder } from "../../src/dispatch-repository.js";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../../src/scm-dependency-command-service.js";
import { applyLocalCoCargo } from "../../src/dispatch-local-co-cargo.js";
import { seed, sourceCo, command, sources } from "./co-direct-to-fixture.mjs";

after(closeDb);
const rollback = run => withTransaction(run, { rollback: true });

async function packedCo() {
  const f = await seed();
  f.co = await sourceCo(f);
  for (let i = 3; i <= 7; i += 1) {
    await query(`INSERT INTO local_co_order_lines (co_id,line_id,item_id,item_name,sku,item_type,
      quantity,piece_qty,to_pcs,unit,packed_piece_qty,confirmed_at)
      VALUES ($1,$2::bigint,$2::bigint,'Packed wall','WALL','InvtPart',$3,$3,1,'PC',$3,now())`, [f.co.id, i, i]);
  }
  f.packed = (await getLocalCoOrder(f.co.co_ref)).lines.filter(row => row.confirmed_at);
  return f;
}

async function linkBoth(f) {
  const c = await command(f);
  c.payload.allocations.push({ salesLineId: f.palletId, quantities: { salesQty: 1 } });
  c.payloadHash = scmDependencyPayloadHash(c);
  return executeScmDependencyCommand(c);
}

test("direct Trevista and one pallet leave six pallets and preserve the five packed CO lines", () => rollback(async () => {
  const f = await packedCo();
  const before = await sources(f);
  await linkBoth(f);
  const detail = await getDeliveryOrder(f.co.co_ref);
  assert.equal(detail.lines.some(line => Number(line.item_id) === 1356), false);
  assert.equal(Number(detail.lines.find(line => Number(line.item_id) === 1784).quantity), 6);
  assert.deepEqual((await getLocalCoOrder(f.co.co_ref)).lines.filter(row => row.confirmed_at), f.packed);
  assert.deepEqual(await sources(f), before);
  const manifest = await getLocalCoOrder(f.co.co_ref);
  const projected = applyLocalCoCargo({ id: f.co.co_ref }, { coRef: f.co.co_ref, cargoLines: manifest.lines });
  assert.equal(projected.items.length, 6);
  assert.equal(projected.items.some(item => item.itemId === 1356), false);
  assert.equal(projected.items.find(item => item.itemId === 1784).quantity, 6);
}));

test("ownerless confirmed packing appears in Packed and its unfilled lines stay in Active", () => rollback(async () => {
  const f = await packedCo();
  await linkBoth(f);
  const packed = await listDeliveryOrders({ locationId: 26, status: "packed", orderType: "sales_order" });
  const active = await listDeliveryOrders({ locationId: 26, status: "active", orderType: "sales_order" });
  const card = packed.find(row => row.tranid === f.co.co_ref);
  assert.ok(card, "CO must be visible in the actual Packed list");
  assert.equal(card.operator_status, "packed");
  assert.equal(card.underpack_count, 1);
  assert.equal(card.line_count, 6);
  assert.ok(active.some(row => row.tranid === f.co.co_ref));
  const detail = await getDeliveryOrder(f.co.co_ref);
  assert.equal(detail.status, "packed", "CO load requires a packed status");
  assert.equal(detail.lines.filter(line => Number(line.packed_piece_qty) > 0).length, 5);
  const validation = validateConsolidatedDeliveryOrder(detail);
  assert.equal(validation.ok, true, JSON.stringify(validation));
}));

test("CO creation after a direct link subtracts its quantity exactly once across source and CO refreshes", () => rollback(async () => {
  const f = await seed();
  await query("UPDATE sales_orders SET operator_status='open' WHERE netsuite_id=$1", [f.salesId]);
  await query("UPDATE sales_order_lines SET packed_sales_qty=0,confirmed=false,confirmed_at=null WHERE sales_order_id=$1", [f.salesId]);
  const c = await command(f);
  await executeScmDependencyCommand(c);
  assert.equal((await executeScmDependencyCommand(c)).idempotent, true);
  const co = await sourceCo(f);
  assert.equal((await getDeliveryOrder(co.co_ref)).lines.some(line => Number(line.item_id) === 1356), false);
  await sourceCo(f);
  for (let i = 0; i < 3; i += 1) {
    const canonical = await getLocalCoOrder(co.co_ref);
    const order = applyLocalCoCargo({ id: co.co_ref }, { coRef: co.co_ref, cargoLines: canonical.lines });
    await upsertLocalCoOrder({ sourceOrderRef: f.salesRef, fromYard: "150", toYard: "3445", order });
  }
  assert.equal((await getDeliveryOrder(co.co_ref)).lines.some(line => Number(line.item_id) === 1356), false);
  const current = await getLocalCoOrder(co.co_ref);
  assert.equal(current.lines.length, 2, "retain reversible source requirements");
}));

test("fully packed CO has no Active remainder", () => rollback(async () => {
  const f = await packedCo();
  await query("UPDATE local_co_order_lines SET packed_sales_qty=quantity,confirmed_at=now() WHERE co_id=$1 AND item_id=1784", [f.co.id]);
  await executeScmDependencyCommand(await command(f));
  assert.ok((await listDeliveryOrders({ status: "packed" })).some(row => row.tranid === f.co.co_ref));
  assert.equal((await listDeliveryOrders({ status: "active" })).some(row => row.tranid === f.co.co_ref), false);
}));

test("an operator-owned CO preparation is not advertised as loadable Packed", () => rollback(async () => {
  const f = await packedCo();
  await query("UPDATE local_co_orders SET status='preparing',preparing_started_at=now() WHERE id=$1", [f.co.id]);
  assert.equal((await listDeliveryOrders({ status: "packed" })).some(row => row.tranid === f.co.co_ref), false);
  assert.ok((await listDeliveryOrders({ status: "active" })).some(row => row.tranid === f.co.co_ref));
}));
