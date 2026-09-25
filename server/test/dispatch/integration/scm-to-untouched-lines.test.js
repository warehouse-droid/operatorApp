import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import fc from "fast-check";
import { closeDb, pool, query, withTransaction } from "../../../src/db.js";
import { lockConsolidatedLoadOrders } from "../../../src/consolidation-load-locks.js";
import { resolveDispatchSalesTarget } from "../../../src/dispatch-order-target-repository.js";
import { previewScmDependencyMutation } from "../../../src/scm-dependency-preview-service.js";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../../../src/scm-dependency-command-service.js";
import { upsertLocalCoOrder } from "../../../src/dispatch-repository.js";

after(closeDb);
let sequence = 0;
const rollback = (run) => withTransaction(run, { rollback: true });
const activityColumns = ["confirmed", "confirmed_at", "packed_pallet_qty", "packed_layer_qty",
  "packed_section_qty", "packed_piece_qty", "packed_sales_qty", "loaded_qty"];

async function seed() {
  const base = 9_913_000_000 + (sequence += 10);
  const f = { salesId: base, salesRef: `SO-UNTOUCHED-${base}`, transferId: base + 1, transferRef: `TO-UNTOUCHED-${base}` };
  await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,customer,sales_order_type,
    outbound_location_id,outbound_location,operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
    VALUES ($1,$2,'B','Sales Order : Pending Fulfillment','Untouched regression','Delivery',26,'150',
      'packed','Open','not_fulfilled',true)`, [f.salesId, f.salesRef]);
  for (const [index, item, quantity, packed] of [[1, 1356, 52.25, 0], [2, 1784, 7, 5]]) {
    const line = (await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,sku,
      item_type,item_type_text,quantity,unit,layer_qty,to_lyr,confirmed,confirmed_at,packed_sales_qty,
      netsuite_backordered_qty,netsuite_active)
      VALUES ($1,$2,$3,$4,$4,'InvtPart','Inventory Item',$5,$6,$7,$8,$9,
        CASE WHEN $9 THEN now() ELSE NULL END,$10,$11,true) RETURNING id`,
    [f.salesId, index, item, index === 1 ? "TREVISTA" : "PALLET", quantity,
      index === 1 ? "SQFT" : "EACH", index === 1 ? 5 : 0, index === 1 ? 10.45 : 0,
      packed > 0, packed, index === 1 ? quantity : 0])).rows[0];
    if (index === 1) {f.materialId = Number(line.id);}
    else {f.palletId = Number(line.id);}
  }
  await query(`INSERT INTO transfer_orders (netsuite_id,tranid,status,status_text,from_location_id,from_location,
    to_location_id,to_location,outbound_operator_status,local_yard_order_status,fulfillment_status,receiving_status,netsuite_active)
    VALUES ($1,$2,'B','Transfer Order : Pending Fulfillment',1,'3445',26,'150','open','Open','not_fulfilled','not_received',true)`,
  [f.transferId, f.transferRef]);
  for (const stage of ["outbound", "receiving"]) {
    await query(`INSERT INTO transfer_order_lines (transfer_order_id,line_id,line_stage,item_id,item_name,sku,
      item_type,item_type_text,quantity,unit,layer_qty,to_lyr,confirmed,netsuite_active)
      VALUES ($1,1,$2,1356,'TREVISTA','TREVISTA','InvtPart','Inventory Item',52.25,'SQFT',5,10.45,false,true),
        ($1,2,$2,1784,'PALLET','PALLET','InvtPart','Inventory Item',1,'EACH',0,0,false,true)`, [f.transferId, stage]);
  }
  return f;
}

async function command(f, { mode = "direct_to_customer", quantity = 52.25, targetRef = f.salesRef } = {}) {
  const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: targetRef });
  const line = resolved.lines.find(row => row.salesLineId === f.materialId);
  assert.ok(line);
  const result = { requestId: crypto.randomUUID(), action: "link_to", targetRef,
    targetSignature: resolved.signature, payload: { transferOrderRef: f.transferRef, mode,
      allocations: [{ targetLineKey: line.targetLineKey, quantities: { salesQty: quantity } }] } };
  result.payloadHash = scmDependencyPayloadHash(result);
  return result;
}

async function sources(f) {
  const state = {};
  for (const [name, sql, id] of [
    ["sales", "SELECT * FROM sales_orders WHERE netsuite_id=$1", f.salesId],
    ["salesLines", "SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id", f.salesId],
    ["transfer", "SELECT * FROM transfer_orders WHERE netsuite_id=$1", f.transferId],
    ["transferLines", "SELECT * FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY id", f.transferId]
  ]) {state[name] = (await query(sql, [id])).rows;}
  return state;
}

async function blocked(c, code = "OPERATOR_ACTIVITY_STARTED") {
  const result = await previewScmDependencyMutation(c);
  assert.equal(result.allowed, false, JSON.stringify(result.blockers));
  assert.ok(result.blockers.some(row => row.code === code), JSON.stringify(result.blockers));
}

async function sourceCo(f) {
  return upsertLocalCoOrder({ sourceOrderRef: f.salesRef, fromYard: "150", toYard: "3445",
    order: { id: f.salesRef, type: "SO", items: [
      { lineRowId: f.materialId, lineId: 1, itemId: 1356, itemName: "TREVISTA", quantity: 52.25, layers: 5, unit: "SQFT" },
      { lineRowId: f.palletId, lineId: 2, itemId: 1784, itemName: "PALLET", quantity: 7, unit: "EACH" }
    ] } });
}

test("TO links protect a selected line already packed on its source CO after the SO is released", () => rollback(async () => {
  const f = await seed();
  const co = await sourceCo(f);
  await query("UPDATE local_co_order_lines SET packed_layer_qty=1,confirmed_at=now() WHERE co_id=$1 AND item_id=1356", [co.id]);
  await blocked(await command(f));
}));

test("TO links still accept an untouched CO line when a different CO line is packed", () => rollback(async () => {
  const f = await seed();
  const co = await sourceCo(f);
  await query("UPDATE local_co_order_lines SET packed_sales_qty=5,confirmed_at=now() WHERE co_id=$1 AND item_id=1784", [co.id]);
  assert.equal((await previewScmDependencyMutation(await command(f))).allowed, true);
}));

test("TO linking waits for CO operator packing before checking the selected line", async () => {
  const f = await seed();
  const co = await sourceCo(f);
  const c = await command(f);
  const client = await pool.connect();
  let checking;
  let pid;
  let waiting = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${co.delivery_order_id}`]);
    checking = withTransaction(async () => {
      pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return previewScmDependencyMutation(c, {}, { lock: true });
    });
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
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some(row => row.code === "OPERATOR_ACTIVITY_STARTED"));
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await checking?.catch(() => null);
    await query("DELETE FROM local_co_orders WHERE id=$1", [co.id]);
    await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1", [f.transferId]);
    await query("DELETE FROM transfer_orders WHERE netsuite_id=$1", [f.transferId]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=$1", [f.salesId]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=$1", [f.salesId]);
  }
});

test("TO linking retries if a CO takes over while it waits for the SO operator lock", async () => {
  const f = await seed();
  const c = await command(f);
  let unlock;
  let ready;
  let pid;
  let co;
  const held = new Promise(resolve => {ready = resolve;});
  const release = new Promise(resolve => {unlock = resolve;});
  const creation = withTransaction(async () => {
    await lockConsolidatedLoadOrders([f.salesId]);
    ready();
    await release;
    co = await sourceCo(f);
  });
  await held;
  const checking = withTransaction(async () => {
    pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return previewScmDependencyMutation(c, {}, { lock: true });
  }).then(value => ({ value }), error => ({ error }));
  let waiting = false;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (pid) {
        waiting = (await query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
        if (waiting) {break;}
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    unlock();
    await creation;
    const result = await checking;
    assert.equal(waiting, true);
    assert.equal(result.error?.code, "CO_SOURCE_PACKING_CHANGED");
    assert.equal((await previewScmDependencyMutation(c)).allowed, true, "a fresh preview uses the new CO");
  } finally {
    unlock();
    await creation;
    await checking;
    if (co) {await query("DELETE FROM local_co_orders WHERE id=$1", [co.id]);}
    await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1", [f.transferId]);
    await query("DELETE FROM transfer_orders WHERE netsuite_id=$1", [f.transferId]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=$1", [f.salesId]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=$1", [f.salesId]);
  }
});

for (const mode of ["direct_to_customer", "yard_replenishment"]) {
  test(`${mode}: untouched material links and extends while preserving packed SO lines`, () => rollback(async () => {
    const f = await seed();
    const before = await sources(f);
    const c = await command(f, { mode, quantity: 26.125 });
    assert.equal((await previewScmDependencyMutation(c)).allowed, true);
    const result = await executeScmDependencyCommand(c);
    assert.equal(result.status, "applied");
    assert.equal(result.effectiveAction, "link_to");
    assert.equal((await executeScmDependencyCommand(c)).idempotent, true);
    const extension = await executeScmDependencyCommand(await command(f, { mode, quantity: 26.125 }));
    assert.equal(extension.effectiveAction, "extend_to");
    const rows = (await query(`SELECT l.sales_line_id,l.allocated_quantity FROM order_dependency_lines l
      JOIN order_dependencies d ON d.id=l.dependency_id WHERE d.transfer_order_ref=$1 AND l.line_role='sales_allocation'`, [f.transferRef])).rows;
    assert.deepEqual(rows.map(row => [Number(row.sales_line_id), Number(row.allocated_quantity)]), [[f.materialId, 52.25]]);
    assert.deepEqual(await sources(f), before);
  }));
}

for (const column of activityColumns) {
  test(`selected line with ${column} is blocked`, () => rollback(async () => {
    const f = await seed();
    const value = column === "confirmed" ? "true" : column === "confirmed_at" ? "now()" : "1";
    await query(`UPDATE sales_order_lines SET ${column}=${value} WHERE id=$1`, [f.materialId]);
    await blocked(await command(f));
  }));
}

test("mixed selection including the packed pallet is rejected without writing a link", () => rollback(async () => {
  const f = await seed();
  const c = await command(f);
  c.payload.allocations.push({ salesLineId: f.palletId, quantities: { salesQty: 1 } });
  c.payloadHash = scmDependencyPayloadHash(c);
  const before = await sources(f);
  await assert.rejects(executeScmDependencyCommand(c), { code: "OPERATOR_ACTIVITY_STARTED" });
  assert.deepEqual(await sources(f), before);
  assert.equal((await query("SELECT id FROM order_dependencies WHERE transfer_order_ref=$1", [f.transferRef])).rowCount, 0);
}));

for (const status of ["open", "confirmed", "packed"]) {
  test(`aggregate ${status} permits explicit untouched lines`, () => rollback(async () => {
    const f = await seed();
    await query("UPDATE sales_orders SET operator_status=$2,local_yard_order_status=$2 WHERE netsuite_id=$1", [f.salesId, status]);
    assert.equal((await previewScmDependencyMutation(await command(f))).allowed, true);
  }));
}

for (const status of ["preparing", "loaded", "fulfilled", "shipped", "received", "complete", "completed"]) {
  test(`whole-order ${status} remains protected`, () => rollback(async () => {
    const f = await seed();
    await query("UPDATE sales_orders SET operator_status=$2 WHERE netsuite_id=$1", [f.salesId, status]);
    await blocked(await command(f));
  }));
}

for (const update of ["preparing_operator_id='untouched-test'", "preparing_started_at=now()", "local_yard_order_status='Loaded'"]) {
  test(`whole-order lock ${update} remains protected`, () => rollback(async () => {
    const f = await seed();
    await query(`UPDATE sales_orders SET ${update} WHERE netsuite_id=$1`, [f.salesId]);
    await blocked(await command(f));
  }));
}

test("loading on another SO line still blocks linking", () => rollback(async () => {
  const f = await seed();
  await query("UPDATE sales_order_lines SET loaded_qty=1 WHERE id=$1", [f.palletId]);
  await blocked(await command(f));
}));

test("key-first and legacy line identities inspect exactly the row relationship creation uses", () => rollback(async () => {
  const f = await seed();
  const c = await command(f);
  c.payload.allocations[0].salesLineId = f.palletId;
  assert.equal((await previewScmDependencyMutation(c)).allowed, true, "valid key wins over legacy ID");
  c.payload.allocations[0] = { targetLineKey: "stale-key", salesLineId: f.materialId, quantities: { salesQty: 52.25 } };
  assert.equal((await previewScmDependencyMutation(c)).allowed, true, "valid legacy ID fallback is supported");
  c.payloadHash = scmDependencyPayloadHash(c);
  assert.equal((await executeScmDependencyCommand(c)).status, "applied");
  c.payload.allocations[0].salesLineId = f.palletId;
  await blocked(c);
}));

for (const allocations of [undefined, [], [{ targetLineKey: "unknown" }], [null], "not-an-array"]) {
  test(`ambiguous allocation ${JSON.stringify(allocations)} retains whole-order protection`, () => rollback(async () => {
    const f = await seed();
    const c = await command(f);
    c.payload.allocations = allocations;
    await blocked(c);
  }));
}

test("partly valid allocations cannot bypass the whole-order check", () => rollback(async () => {
  const f = await seed();
  const c = await command(f);
  c.payload.allocations.push({ salesLineId: -1 });
  await blocked(c);
  c.action = "link_po";
  c.payload.allocations.pop();
  await blocked(c);
}));

test("PO preview retains its existing confirmation-timestamp behavior", () => rollback(async () => {
  const f = await seed();
  await query("UPDATE sales_orders SET operator_status='open' WHERE netsuite_id=$1", [f.salesId]);
  await query("UPDATE sales_order_lines SET confirmed=false,packed_sales_qty=0,confirmed_at=now() WHERE sales_order_id=$1", [f.salesId]);
  const c = await command(f);
  c.action = "link_po";
  assert.equal((await previewScmDependencyMutation(c)).allowed, true);
}));

for (const [scenario, update, code] of [
  ["TO outbound", "UPDATE transfer_order_lines SET packed_sales_qty=1 WHERE transfer_order_id=$1 AND line_stage='outbound'", "OPERATOR_ACTIVITY_STARTED"],
  ["TO header", "UPDATE transfer_orders SET outbound_operator_status='packed' WHERE netsuite_id=$1", "OPERATOR_ACTIVITY_STARTED"],
  ["TO receiving", "UPDATE transfer_order_lines SET received_sales_qty=1 WHERE transfer_order_id=$1 AND line_stage='receiving'", "SCM_RECEIVING_ACTIVITY_STARTED"],
  ["closed TO", "UPDATE transfer_orders SET status='H',status_text='Transfer Order : Closed' WHERE netsuite_id=$1", "ORDER_CLOSED"]
]) {
  test(`${scenario} protection survives explicit untouched selection`, () => rollback(async () => {
    const f = await seed();
    await query(update, [f.transferId]);
    await blocked(await command(f), code);
  }));
}

test("started driver and stale target remain blockers", () => rollback(async () => {
  const f = await seed();
  const c = await command(f);
  c.targetSignature = "stale";
  await blocked(c, "DISPATCH_TARGET_CHANGED");
  delete c.targetSignature;
  await query(`INSERT INTO driver_job_records (job_id,plan_date,driver_login,stop_type,order_refs,status,started_at)
    VALUES ($1,'2099-09-16','untouched-driver','pickup',$2::jsonb,'in_progress',now())`, [crypto.randomUUID(), JSON.stringify([f.salesRef])]);
  await blocked(c, "DRIVER_ACTIVITY_STARTED");
}));

for (const kind of ["group", "split"]) {
  test(`${kind} selections use canonical source-line activity`, () => rollback(async () => {
    const f = await seed();
    const targetRef = kind === "group" ? `GOB-${f.salesId}` : `${f.salesRef}-S1`;
    const order = kind === "group"
      ? { id: targetRef, type: "SO", childOrders: [f.salesRef], childOrderDetails: [{ id: f.salesRef, type: "SO" }] }
      : { id: targetRef, type: "SO", originalOrderId: f.salesRef,
        items: [{ lineRowId: f.materialId, itemId: 1356, quantity: 52.25, layers: 5 }] };
    const plan = (await query("INSERT INTO dispatch_plans (plan_date,status) VALUES ('2099-09-16','draft') RETURNING id")).rows[0];
    await query("INSERT INTO dispatch_plan_snapshots (plan_id,orders,trucks,summary) VALUES ($1,$2::jsonb,'[]','{}')", [plan.id, JSON.stringify([order])]);
    const c = await command(f, { targetRef });
    assert.equal((await previewScmDependencyMutation(c)).allowed, true);
    await query("UPDATE sales_order_lines SET packed_sales_qty=1 WHERE id=$1", [f.materialId]);
    await blocked(c);
  }));
}

test("failed receipt finalization rolls back the link and preserves packing", () => rollback(async () => {
  const f = await seed();
  const before = await sources(f);
  await assert.rejects(executeScmDependencyCommand(await command(f), {}, {
    completeReceipt: async () => {throw new Error("injected receipt failure");}
  }), /injected receipt failure/u);
  assert.deepEqual(await sources(f), before);
  assert.equal((await query("SELECT id FROM order_dependencies WHERE transfer_order_ref=$1", [f.transferRef])).rowCount, 0);
}));

test("confirmed route refresh preserves existing packing when an untouched line is linked", () => rollback(async () => {
  const f = await seed();
  const truck = (await query("INSERT INTO dispatch_trucks (plate,active) VALUES ($1,true) RETURNING id::text,plate", [`UNTOUCHED-${f.salesId}`])).rows[0];
  const plan = (await query("INSERT INTO dispatch_plans (plan_date,status) VALUES ('2099-09-16','confirmed') RETURNING id")).rows[0];
  const order = { id: f.salesRef, type: "SO", sourceYard: "150", pickupLocations: ["150"], address: "100 Test Street",
    items: [{ lineRowId: f.materialId, itemId: 1356, sku: "TREVISTA", itemType: "InvtPart", quantity: 52.25, layers: 5 },
      { lineRowId: f.palletId, itemId: 1784, sku: "PALLET", itemType: "InvtPart", quantity: 7 }] };
  const trucks = [{ id: truck.id, plate: truck.plate, loads: [{ id: "untouched-load", name: "Load 1", stops: [
    { id: "untouched-pick", type: "pick", orderId: f.salesRef, location: "150", timing: { arrival: 420, depart: 450 } },
    { id: "untouched-drop", type: "drop", orderId: f.salesRef, location: "150", timing: { arrival: 480, depart: 510 } }
  ] }] }];
  await query("INSERT INTO dispatch_plan_snapshots (plan_id,orders,trucks,summary) VALUES ($1,$2::jsonb,$3::jsonb,'{}')", [plan.id, JSON.stringify([order]), JSON.stringify(trucks)]);
  const packing = async () => (await query(`SELECT id,confirmed,confirmed_at,packed_pallet_qty,packed_layer_qty,
    packed_section_qty,packed_piece_qty,packed_sales_qty,loaded_qty FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id`, [f.salesId])).rows;
  const before = await packing();
  const c = await command(f);
  assert.equal((await previewScmDependencyMutation(c)).allowed, true);
  assert.equal((await executeScmDependencyCommand(c)).status, "applied");
  assert.deepEqual(await packing(), before);
}));

test("generated selected/unrelated activity obeys both allow and block invariants", () => rollback(async () => {
  const f = await seed();
  const c = await command(f);
  await fc.assert(fc.asyncProperty(
    fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.constantFrom("open", "confirmed", "packed"),
    async (selected, other, loaded, preparing, status) => {
      await query(`UPDATE sales_order_lines SET confirmed=$2,confirmed_at=NULL,packed_sales_qty=$3,loaded_qty=0 WHERE id=$1`,
        [f.materialId, selected, selected ? 1 : 0]);
      await query(`UPDATE sales_order_lines SET confirmed=$2,confirmed_at=NULL,packed_sales_qty=$3,loaded_qty=$4 WHERE id=$1`,
        [f.palletId, other, other ? 5 : 0, loaded ? 1 : 0]);
      await query("UPDATE sales_orders SET operator_status=$2,preparing_operator_id=$3 WHERE netsuite_id=$1",
        [f.salesId, status, preparing ? "busy" : null]);
      const preview = await previewScmDependencyMutation(c);
      assert.equal(preview.allowed, !(selected || loaded || preparing));
    }
  ), { seed: 88381102, numRuns: 64 });
}));

test("commit activity check waits for operator locks and rechecks committed packing", async () => {
  const f = await withTransaction(seed);
  const client = await pool.connect();
  try {
    const c = await command(f);
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${f.salesId}`]);
    await client.query("UPDATE sales_order_lines SET packed_sales_qty=1 WHERE id=$1", [f.materialId]);
    const checking = withTransaction(async () => {
      const pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      waitingPid = pid;
      return previewScmDependencyMutation(c, {}, { lock: true });
    });
    let waitingPid;
    let locked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (waitingPid) {
        locked = (await client.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [waitingPid])).rows[0]?.waiting;
        if (locked) {break;}
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.query("COMMIT");
    const result = await checking;
    assert.equal(locked, true, "preview must serialize with actual operator order locks");
    assert.equal(result.allowed, false);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1", [f.transferId]);
    await query("DELETE FROM transfer_orders WHERE netsuite_id=$1", [f.transferId]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=$1", [f.salesId]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=$1", [f.salesId]);
  }
});

test("commit holds row and operator locks through relationship mutation", () => rollback(async () => {
  const f = await seed();
  await lockConsolidatedLoadOrders([f.salesId]);
  await previewScmDependencyMutation(await command(f), {}, { lock: true });
  const pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const locks = (await query(`SELECT relation::regclass::text AS relation,mode FROM pg_locks
    WHERE pid=$1 AND relation IN ('sales_orders'::regclass,'sales_order_lines'::regclass)`, [pid])).rows;
  for (const relation of ["sales_orders", "sales_order_lines"]) {
    assert.ok(locks.some(row => row.relation === relation && row.mode === "RowShareLock"), `${relation} must have FOR UPDATE protection`);
  }
}));
