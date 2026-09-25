import assert from "node:assert/strict";
import test, { after } from "node:test";
import { query, withTransaction, closeDb, pool } from "../../../src/db.js";
import crypto from "node:crypto";
import fc from "fast-check";
import { getDeliveryOrder, listDeliveryOrders, validateConsolidatedDeliveryOrder } from "../../../src/delivery-repository.js";
import { upsertLocalCoOrder, getLocalCoOrder } from "../../../src/dispatch-repository.js";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../../../src/scm-dependency-command-service.js";
import { applyLocalCoCargo } from "../../../src/dispatch-local-co-cargo.js";
import { seed, sourceCo, command, sources } from "../../support/co-direct-to-fixture.mjs";
import { reconcileCoDirectToCargo, coDirectToRequirement, restoreCoSourceRequirement } from "../../../src/co-direct-to-cargo.js";

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
  assert.equal(detail.lines.find(line => Number(line.item_id) === 1356)?.no_yard_load_required, true);
  assert.equal(detail.lines.find(line => Number(line.item_id) === 1356)?.quantity, 0);
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
  assert.equal(card.line_count, 7);
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
  assert.equal((await getDeliveryOrder(co.co_ref)).lines.find(line => Number(line.item_id) === 1356)?.no_yard_load_required, true);
  assert.equal((await getDeliveryOrder(co.co_ref)).lines.find(line => Number(line.item_id) === 1356)?.quantity, 0);
  await sourceCo(f);
  for (let i = 0; i < 3; i += 1) {
    const canonical = await getLocalCoOrder(co.co_ref);
    const order = applyLocalCoCargo({ id: co.co_ref }, { coRef: co.co_ref, cargoLines: canonical.lines });
    await upsertLocalCoOrder({ sourceOrderRef: f.salesRef, fromYard: "150", toYard: "3445", order });
  }
  assert.equal((await getDeliveryOrder(co.co_ref)).lines.find(line => Number(line.item_id) === 1356)?.no_yard_load_required, true);
  assert.equal((await getDeliveryOrder(co.co_ref)).lines.find(line => Number(line.item_id) === 1356)?.quantity, 0);
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

async function change(f, action, payload) {
  const c = await command(f);
  Object.assign(c, { action, payload, requestId: crypto.randomUUID() });
  c.payloadHash = scmDependencyPayloadHash(c);
  return executeScmDependencyCommand(c);
}

test("mode changes and unlink restore the original independent CO requirement", () => rollback(async () => {
  const f = await seed();
  const co = await sourceCo(f);
  const linked = await executeScmDependencyCommand(await command(f, { quantity: 26.125 }));
  const material = async () => (await getDeliveryOrder(co.co_ref)).lines.find(line => Number(line.item_id) === 1356);
  assert.equal(Number((await material()).quantity), 26.125);
  assert.equal(Number((await material()).layer_qty), 2.5);
  await change(f, "change_mode", { dependencyId: linked.dependencyId, mode: "yard_replenishment" });
  assert.equal(Number((await material()).quantity), 52.25);
  assert.equal(Number((await material()).layer_qty), 5);
  await change(f, "change_mode", { dependencyId: linked.dependencyId, mode: "direct_to_customer" });
  assert.equal(Number((await material()).quantity), 26.125);
  await change(f, "unlink_to", { dependencyId: linked.dependencyId });
  assert.equal(Number((await material()).quantity), 52.25);
  await reconcileCoDirectToCargo({ coRefs: [co.co_ref] });
  assert.equal(Number((await material()).quantity), 52.25);
}));

test("yard replenishment leaves CO cargo unchanged", () => rollback(async () => {
  const f = await seed();
  const co = await sourceCo(f);
  const before = await getLocalCoOrder(co.co_ref);
  await executeScmDependencyCommand(await command(f, { mode: "yard_replenishment" }));
  assert.deepEqual(await getLocalCoOrder(co.co_ref), before);
}));

test("reconciliation refuses a legacy direct allocation on packed cargo and rolls back other changes", () => rollback(async () => {
  const f = await packedCo();
  await linkBoth(f);
  await query(`UPDATE local_co_order_lines SET quantity=52.25,layer_qty=5,raw=raw-'coDirectToRequirement'
    WHERE co_id=$1 AND item_id=1356`, [f.co.id]);
  await query(`UPDATE local_co_order_lines SET quantity=7,raw=raw-'coDirectToRequirement',packed_sales_qty=1,confirmed_at=now()
    WHERE co_id=$1 AND item_id=1784`, [f.co.id]);
  const before = await getLocalCoOrder(f.co.co_ref);
  await assert.rejects(reconcileCoDirectToCargo({ coRefs: [f.co.co_ref] }), error => error.code === "CO_DIRECT_TO_CARGO_CONFLICT");
  assert.deepEqual(await getLocalCoOrder(f.co.co_ref), before);
}));

for (const state of ["loaded", "received", "completed", "cancelled"]) {
  test(`${state} CO cargo is not reconciled`, () => rollback(async () => {
    const f = await seed();
    const co = await sourceCo(f);
    await executeScmDependencyCommand(await command(f));
    await query("UPDATE local_co_order_lines SET quantity=52.25,layer_qty=5 WHERE co_id=$1 AND item_id=1356", [co.id]);
    await query("UPDATE local_co_orders SET status=$2 WHERE id=$1", [co.id, state]);
    const before = await getLocalCoOrder(co.co_ref);
    assert.deepEqual(await reconcileCoDirectToCargo({ coRefs: [co.co_ref] }), []);
    assert.deepEqual(await getLocalCoOrder(co.co_ref), before);
  }));
}

test("canonical source identities prevent ambiguous legacy line matching", () => rollback(async () => {
  const f = await seed();
  const other = await seed();
  const co = await sourceCo(f);
  await query("UPDATE local_co_orders SET details=jsonb_build_object('childOrderIds',$2::jsonb) WHERE id=$1", [co.id, JSON.stringify([other.salesRef])]);
  await executeScmDependencyCommand(await command(f));
  await query("UPDATE local_co_order_lines SET raw='{}'::jsonb WHERE co_id=$1 AND item_id=1356", [co.id]);
  await assert.rejects(reconcileCoDirectToCargo({ coRefs: [co.co_ref] }), /multiple SO lines/);
}));

test("a zero operational manifest cannot resurrect a stale Dispatch item", () => {
  const result = applyLocalCoCargo({ id: "CO-EMPTY", items: [{ quantity: 52.25 }], weight: 100 },
    { coRef: "CO-EMPTY", cargoLines: [{ line_id: 1, item_id: 1356, quantity: 0, layer_qty: 0 }] });
  assert.deepEqual(result.items, []);
  assert.equal(result.weight, 0);
  assert.equal(result.salesQty, 0);
});

test("generated partial allocations conserve quantities and restoration is idempotent", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 0, max: 10000 }), (units, allocation) => {
    const quantity = units / 4;
    const taken = Math.min(quantity, allocation / 4);
    const line = { quantity, layer_qty: quantity / 10, piece_qty: quantity, pallet_qty: 0, section_qty: 0 };
    const first = coDirectToRequirement(line, taken);
    assert.equal(first.required.quantity + taken, quantity);
    assert.equal(first.required.layer_qty, Number(((quantity - taken) / 10).toFixed(6)));
    const saved = { ...first.required, raw: { coDirectToRequirement: first.base } };
    assert.deepEqual(coDirectToRequirement(saved, taken), first);
    assert.deepEqual(coDirectToRequirement(saved, 0).required, line);
    const input = restoreCoSourceRequirement({ quantity: first.required.quantity, coDirectToRequirement: first.base });
    assert.equal(input.quantity, quantity);
    assert.equal(input.layers, line.layer_qty);
  }), { numRuns: 100, seed: 881102 });
});

test("invalid cargo and non-finite allocations fail closed", () => {
  for (const bad of [-1, Infinity, "not-a-number"]) {
    assert.throws(() => coDirectToRequirement({ quantity: 7 }, bad), /invalid quantity/);
    assert.throws(() => restoreCoSourceRequirement({ coDirectToRequirement: { quantity: bad } }), /invalid quantity/);
  }
  assert.equal(coDirectToRequirement({ quantity: 0 }, 0).required.quantity, 0);
  assert.equal(coDirectToRequirement({ quantity: 1, piece_qty: 1 }, 5).required.piece_qty, 0);
});

test("concurrent CO packing is observed after the shared operator lock", async () => {
  const f = await seed();
  const co = await sourceCo(f);
  await executeScmDependencyCommand(await command(f));
  await query("UPDATE local_co_order_lines SET quantity=52.25,layer_qty=5,raw=raw-'coDirectToRequirement' WHERE co_id=$1 AND item_id=1356", [co.id]);
  const client = await pool.connect();
  let checking;
  let pid;
  let waiting = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${co.delivery_order_id}`]);
    checking = withTransaction(async () => {
      pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return reconcileCoDirectToCargo({ coRefs: [co.co_ref] });
    }).then(result => ({ result }), error => ({ error }));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (pid) {
        waiting = (await client.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
        if (waiting) {break;}
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.query("UPDATE local_co_order_lines SET packed_layer_qty=1,confirmed_at=now() WHERE co_id=$1 AND item_id=1356", [co.id]);
    await client.query("COMMIT");
    const result = await checking;
    assert.equal(waiting, true);
    assert.equal(result.error?.code, "CO_DIRECT_TO_CARGO_CONFLICT");
    assert.equal(Number((await getLocalCoOrder(co.co_ref)).lines.find(line => Number(line.item_id) === 1356).quantity), 52.25);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await checking;
    await query("DELETE FROM local_co_orders WHERE id=$1", [co.id]);
    await query("DELETE FROM order_dependencies WHERE sales_order_id=$1", [f.salesId]);
    await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1", [f.transferId]);
    await query("DELETE FROM transfer_orders WHERE netsuite_id=$1", [f.transferId]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=$1", [f.salesId]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=$1", [f.salesId]);
  }
});
