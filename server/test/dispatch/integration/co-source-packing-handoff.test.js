import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, withTransaction, closeDb, pool } from "../../../src/db.js";
import { upsertLocalCoOrder, getLocalCoOrder, cancelLocalCoOrder } from "../../../src/dispatch-repository.js";
import { confirmDeliveryLine, confirmDeliveryLines, setDeliveryLinePackedQuantity, updateDeliveryStatus,
  getDeliveryOrder, recordDeliveryLoad, setConsolidationDeliveryLinePackedQuantity, markConsolidationDeliveryOrderPacked } from "../../../src/delivery-repository.js";
import { seedOperatorPickup } from "../../support/operator-ui-enhancements-fixture.mjs";
import { releaseExistingCoSourcePacking, withCoSourcePackingHandoff } from "../../../src/co-source-packing-handoff.js";

after(closeDb);
const rollback = run => withTransaction(run, { rollback: true });
const packedFields = ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];

async function fixture() {
  const f = await seedOperatorPickup();
  await query(`UPDATE sales_orders SET sales_order_type='Delivery',operator_status='packed',fulfillment_status='not_fulfilled',
    preparing_operator_id=$2,preparing_started_at=now() WHERE netsuite_id=$1`, [f.orderId, f.operator.id]);
  await query("UPDATE sales_order_lines SET packed_piece_qty=12,packed_sales_qty=12,confirmed=true,confirmed_at=now() WHERE id=$1", [f.lineId]);
  f.options = { sourceOrderRef: f.tranid, fromYard: "3445", toYard: "150", requestedBy: "handoff-regression",
    order: { id: f.tranid, type: "SO", items: [{ lineRowId: Number(f.lineId), lineId: 1, itemId: 889201,
      sku: "ITEM-A", itemName: "Item A", itemType: "InvtPart", quantity: 20, pieces: 20, toPcs: 1, unit: "PC" }] } };
  return f;
}

async function source(f) {
  return { header: (await query("SELECT * FROM sales_orders WHERE netsuite_id=$1", [f.orderId])).rows[0],
    lines: (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id", [f.orderId])).rows };
}

async function assertReleased(f) {
  const state = await source(f);
  assert.equal(state.header.operator_status, "open");
  assert.equal(state.header.preparing_operator_id, null);
  assert.equal(state.header.preparing_started_at, null);
  for (const line of state.lines) {
    for (const field of packedFields) {assert.equal(Number(line[field]), 0, field);}
    assert.equal(line.confirmed, false);
    assert.equal(line.confirmed_at, null);
  }
  return state;
}

function protectedLine(line) {
  return Object.fromEntries(Object.entries(line).filter(([key]) => !packedFields.includes(key) && !["confirmed", "confirmed_at"].includes(key)));
}

test("creating a CO releases the packed SO without moving its packing or changing ordered lines", () => rollback(async () => {
  const f = await fixture();
  const before = await source(f);
  const co = await upsertLocalCoOrder(f.options);
  const afterState = await assertReleased(f);
  assert.deepEqual(afterState.lines.map(protectedLine), before.lines.map(protectedLine));
  const detail = await getDeliveryOrder(co.co_ref);
  assert.equal(detail.lines.length, 1);
  assert.equal(Number(detail.lines[0].quantity), 20);
  for (const field of packedFields) {assert.equal(Number(detail.lines[0][field]), 0);}
  assert.equal(detail.lines[0].confirmed_at, null);
  const audit = (await query("SELECT details FROM delivery_audit_log WHERE action='delivery.co.source_packing.released' AND order_id=$1", [f.orderId])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.coRef, co.co_ref);
  assert.equal(Number(audit[0].details.lines[0].packed_piece_qty), 12);
}));

test("repeat saves retain existing CO packing and do not repeat the release audit", () => rollback(async () => {
  const f = await fixture();
  const co = await upsertLocalCoOrder(f.options);
  const detail = await getDeliveryOrder(co.co_ref);
  await confirmDeliveryLine(co.delivery_order_id, detail.lines[0].id, { pieces: 7 }, f.operator.id);
  const before = await getDeliveryOrder(co.co_ref);
  await upsertLocalCoOrder(f.options);
  await assertReleased(f);
  const afterState = await getDeliveryOrder(co.co_ref);
  assert.equal(Number(afterState.lines[0].packed_piece_qty), 7);
  assert.equal(String(afterState.lines[0].confirmed_at), String(before.lines[0].confirmed_at));
  assert.equal((await query("SELECT id FROM delivery_audit_log WHERE action='delivery.co.source_packing.released' AND order_id=$1", [f.orderId])).rowCount, 1);
}));

test("handoff does not rewrite untouched source lines", () => rollback(async () => {
  const f = await fixture();
  const line = (await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,item_type,
    quantity,unit,netsuite_active) VALUES ($1,2,1356,'Untouched','InvtPart',52.25,'SQFT',true) RETURNING *`, [f.orderId])).rows[0];
  await upsertLocalCoOrder(f.options);
  assert.deepEqual((await query("SELECT * FROM sales_order_lines WHERE id=$1", [line.id])).rows[0], line);
}));

test("an existing pending CO releases legacy source packing while preserving its own packing", () => rollback(async () => {
  const f = await fixture();
  const co = await upsertLocalCoOrder(f.options);
  await query("UPDATE local_co_order_lines SET packed_piece_qty=6,confirmed_at=now() WHERE co_id=$1", [co.id]);
  await query("UPDATE sales_orders SET operator_status='packed' WHERE netsuite_id=$1", [f.orderId]);
  await query("UPDATE sales_order_lines SET packed_piece_qty=8,confirmed=true,confirmed_at=now() WHERE id=$1", [f.lineId]);
  await upsertLocalCoOrder(f.options);
  await assertReleased(f);
  assert.equal(Number((await getDeliveryOrder(co.co_ref)).lines[0].packed_piece_qty), 6);
}));

for (const action of ["confirm", "quantity", "packed", "preparing"]) {
  test(`stale SO ${action} writes are redirected to its active CO`, () => rollback(async () => {
    const f = await fixture();
    const co = await upsertLocalCoOrder(f.options);
    const operation = action === "confirm" ? () => confirmDeliveryLine(f.orderId, f.lineId, { pieces: 1 }, f.operator.id)
      : action === "quantity" ? () => setDeliveryLinePackedQuantity(f.orderId, f.lineId, { pieces: 1 }, f.operator.id)
        : () => updateDeliveryStatus(f.orderId, action, f.operator.id);
    await assert.rejects(operation, error => error.code === "CO_SOURCE_PACKING_HANDOFF" && error.message.includes(co.co_ref));
    await assertReleased(f);
  }));
}

test("cancelling an unstarted CO restores SO packing eligibility", () => rollback(async () => {
  const f = await fixture();
  const co = await upsertLocalCoOrder(f.options);
  await cancelLocalCoOrder(co.co_ref);
  await confirmDeliveryLine(f.orderId, f.lineId, { pieces: 3 }, f.operator.id);
  assert.equal(Number((await source(f)).lines[0].packed_piece_qty), 3);
}));

test("recreating a cancelled CO releases any packing restarted on its source SO", () => rollback(async () => {
  const f = await fixture();
  const co = await upsertLocalCoOrder(f.options);
  await cancelLocalCoOrder(co.co_ref);
  await confirmDeliveryLine(f.orderId, f.lineId, { pieces: 3 }, f.operator.id);
  const reactivated = await upsertLocalCoOrder({ ...f.options, reactivateCancelled: true });
  assert.equal(reactivated.status, "pending_load");
  await assertReleased(f);
  const detail = await getDeliveryOrder(co.co_ref);
  assert.equal(Number(detail.lines[0].packed_piece_qty), 0);
  assert.equal(Number(detail.lines[0].quantity), 20);
}));

for (const status of ["loaded", "partial_loaded"]) {
  test(`${status} SO packing cannot be cleared by CO creation`, () => rollback(async () => {
    const f = await fixture();
    await query("UPDATE sales_orders SET operator_status=$2 WHERE netsuite_id=$1", [f.orderId, status]);
    const before = await source(f);
    await assert.rejects(() => upsertLocalCoOrder(f.options), error => error.code === "CO_SOURCE_PACKING_EXECUTED");
    assert.deepEqual(await source(f), before);
    assert.equal(await getLocalCoOrder(`CO-${f.tranid}`), null);
  }));
}

test("line-level loading blocks release even with a stale Packed header", () => rollback(async () => {
  const f = await fixture();
  await query("UPDATE sales_order_lines SET loaded_qty=1 WHERE id=$1", [f.lineId]);
  const before = await source(f);
  await assert.rejects(() => upsertLocalCoOrder(f.options), error => error.code === "CO_SOURCE_PACKING_EXECUTED");
  assert.deepEqual(await source(f), before);
}));

test("a loaded CO never releases source packing during a refresh", () => rollback(async () => {
  const f = await fixture();
  const co = await upsertLocalCoOrder(f.options);
  await query("UPDATE local_co_orders SET status='loaded',loaded_at=now() WHERE id=$1", [co.id]);
  await query("UPDATE sales_order_lines SET packed_piece_qty=9,confirmed=true WHERE id=$1", [f.lineId]);
  const before = await source(f);
  await upsertLocalCoOrder(f.options);
  assert.deepEqual(await source(f), before);
}));

test("group handoff only releases SOs at the CO source yard", () => rollback(async () => {
  const first = await fixture();
  const other = await fixture();
  await query("UPDATE sales_orders SET outbound_location_id=26,outbound_location='150' WHERE netsuite_id=$1", [other.orderId]);
  const untouched = await source(other);
  await upsertLocalCoOrder({ ...first.options, sourceOrderRef: `GOA-${crypto.randomUUID()}`,
    order: { type: "SO", childOrders: [first.tranid, other.tranid], childOrderDetails: [
      { id: first.tranid, sourceYard: "3445", items: first.options.order.items },
      { id: other.tranid, sourceYard: "150", items: other.options.order.items }
    ] } });
  await assertReleased(first);
  assert.deepEqual(await source(other), untouched);
}));

test("audit failure rolls back CO creation and source release together", () => rollback(async () => {
  const f = await fixture();
  const before = await source(f);
  await query(`CREATE FUNCTION pg_temp.reject_handoff_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='delivery.co.source_packing.released' THEN RAISE EXCEPTION 'handoff audit failure'; END IF; RETURN NEW; END $$`);
  await query("CREATE TRIGGER test_handoff_audit BEFORE INSERT ON delivery_audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_handoff_audit()");
  await assert.rejects(() => upsertLocalCoOrder(f.options), /handoff audit failure/u);
  assert.deepEqual(await source(f), before);
  assert.equal(await getLocalCoOrder(`CO-${f.tranid}`), null);
}));

test("repairing an existing CO preserves its entire header, lines and current packing", () => rollback(async () => {
  const f = await fixture();
  const co = await upsertLocalCoOrder(f.options);
  await query("UPDATE sales_order_lines SET packed_piece_qty=8,confirmed=true,confirmed_at=now() WHERE id=$1", [f.lineId]);
  await query("UPDATE sales_orders SET operator_status='packed' WHERE netsuite_id=$1", [f.orderId]);
  await query("UPDATE local_co_order_lines SET packed_piece_qty=6,confirmed_at=now() WHERE co_id=$1", [co.id]);
  const readCo = async () => ({
    header: (await query("SELECT * FROM local_co_orders WHERE id=$1", [co.id])).rows,
    lines: (await query("SELECT * FROM local_co_order_lines WHERE co_id=$1 ORDER BY id", [co.id])).rows
  });
  const before = await readCo();
  await releaseExistingCoSourcePacking(co.co_ref);
  await assertReleased(f);
  assert.deepEqual(await readCo(), before);
  const sourceBefore = await source(f);
  await releaseExistingCoSourcePacking(co.co_ref);
  assert.deepEqual(await source(f), sourceBefore);
}));

test("an unknown CO repair fails without touching the source", () => rollback(async () => {
  const f = await fixture();
  const before = await source(f);
  await assert.rejects(() => releaseExistingCoSourcePacking(`MISSING-${f.tranid}`), /Local CO order not found/u);
  assert.deepEqual(await source(f), before);
}));

test("a source owned by Consolidation Load cannot be released", () => rollback(async () => {
  const f = await fixture();
  const batchId = crypto.randomUUID();
  await query(`INSERT INTO operator_consolidated_loads(id,operator_id,location_id,snapshot,snapshot_hash,status)
    VALUES($1,$2,1,'{}','test','pending')`, [batchId, f.operator.id]);
  await query("INSERT INTO operator_consolidated_load_claims(batch_id,order_id) VALUES($1,$2)", [batchId, f.orderId]);
  const before = await source(f);
  await assert.rejects(() => upsertLocalCoOrder(f.options), error => error.code === "CONSOLIDATION_LOAD_ORDER_CLAIMED");
  assert.deepEqual(await source(f), before);
}));

test("an active NetSuite posting claim prevents source release", () => rollback(async () => {
  const f = await fixture();
  const commandId = crypto.randomUUID();
  const gate = (await query("SELECT flag_key,revision FROM mbt_feature_flags ORDER BY flag_key LIMIT 1")).rows[0];
  await query(`INSERT INTO operator_netsuite_posting_commands
    (id,request_id,actor_operator_id,function_key,transaction_type,canonical_location_id,yard_code,gate_key,gate_revision,input_hash)
    VALUES($1,$1,$2,'delivery_prep','IF',1,'3445',$3,$4,$5)`, [commandId, f.operator.id, gate.flag_key, gate.revision, "a".repeat(64)]);
  await query(`INSERT INTO operator_netsuite_posting_order_claims(command_id,function_key,local_order_key)
    VALUES($1,'delivery_prep',$2)`, [commandId, `delivery_prep:sales_order:${f.orderId}`]);
  const before = await source(f);
  await assert.rejects(() => upsertLocalCoOrder(f.options), error => error.code === "OPERATOR_NETSUITE_POSTING_IN_PROGRESS");
  assert.deepEqual(await source(f), before);
}));

test("started Driver work blocks release even before a source loading flag arrives", () => rollback(async () => {
  const f = await fixture();
  await query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status,started_at)
    VALUES($1,'handoff-driver','pickup',$2::jsonb,'in_progress',now())`, [crypto.randomUUID(), JSON.stringify([f.tranid])]);
  const before = await source(f);
  await assert.rejects(() => upsertLocalCoOrder(f.options), error => error.code === "CO_SOURCE_PACKING_EXECUTED");
  assert.deepEqual(await source(f), before);
}));

test("non-SO CO creation leaves unrelated SO packing untouched", () => rollback(async () => {
  const f = await fixture();
  const before = await source(f);
  const ref = `CUSTOM-${crypto.randomUUID()}`;
  const co = await upsertLocalCoOrder({ ...f.options, sourceOrderRef: ref, order: { ...f.options.order, id: ref, type: "CUSTOM" } });
  assert.equal(co.source_order_ref, ref);
  assert.deepEqual(await source(f), before);
}));

test("page, consolidation and loading writes cannot bypass CO ownership", () => rollback(async () => {
  const f = await fixture();
  await upsertLocalCoOrder(f.options);
  for (const operation of [
    () => confirmDeliveryLines(f.orderId, [{ lineId: f.lineId, values: { pieces: 1 } }], f.operator.id),
    () => setConsolidationDeliveryLinePackedQuantity(f.orderId, f.lineId, { pieces: 1 }, f.operator.id),
    () => markConsolidationDeliveryOrderPacked(f.orderId, f.operator.id),
    () => recordDeliveryLoad(f.orderId, f.operator.id, { photoDataUrls: [] })
  ]) {
    await assert.rejects(operation, error => error.code === "CO_SOURCE_PACKING_HANDOFF");
  }
  await assertReleased(f);
}));

test("canonical source rows stay locked through the CO save and release", async () => {
  const f = await fixture();
  const client = await pool.connect();
  try {
    await withCoSourcePackingHandoff({ coRef: `CO-${f.tranid}`, sourceOrderRef: f.tranid, fromYard: "3445" }, async () => {
      for (const [sql, id] of [
        ["UPDATE sales_orders SET operator_status='open' WHERE netsuite_id=$1", f.orderId],
        ["UPDATE sales_order_lines SET packed_piece_qty=10 WHERE id=$1", f.lineId]
      ]) {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='100ms'");
        await assert.rejects(() => client.query(sql, [id]), error => error.code === "55P03");
        await client.query("ROLLBACK");
      }
      return { co_ref: `CO-${f.tranid}` };
    });
    await assertReleased(f);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=$1", [f.orderId]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=$1", [f.orderId]);
  }
});

test("handoff acquires the operator mutex before reading packing quantities", async () => {
  const f = await fixture();
  const client = await pool.connect();
  let operation;
  let pid;
  let waiting = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${f.orderId}`]);
    operation = withTransaction(async () => {
      pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return upsertLocalCoOrder(f.options);
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (pid) {
        waiting = (await client.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
        if (waiting) {break;}
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.query("UPDATE sales_order_lines SET packed_piece_qty=19 WHERE id=$1", [f.lineId]);
    await client.query("COMMIT");
    await operation;
    assert.equal(waiting, true);
    await assertReleased(f);
    const audit = (await query("SELECT details FROM delivery_audit_log WHERE action='delivery.co.source_packing.released' AND order_id=$1", [f.orderId])).rows[0];
    assert.equal(Number(audit.details.lines[0].packed_piece_qty), 19);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await operation?.catch(() => null);
    await query("DELETE FROM local_co_orders WHERE source_order_ref=$1", [f.tranid]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=$1", [f.orderId]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=$1", [f.orderId]);
  }
});

test("generated packing units are released once while CO packing stays independently writable", () => rollback(async () => {
  const f = await fixture();
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 5, maxLength: 5 }), async amounts => {
    await query(`UPDATE sales_order_lines SET packed_pallet_qty=$2,packed_layer_qty=$3,packed_section_qty=$4,
      packed_piece_qty=$5,packed_sales_qty=$6,confirmed=true,confirmed_at=now() WHERE id=$1`, [f.lineId, ...amounts]);
    await query("UPDATE sales_orders SET operator_status='packed' WHERE netsuite_id=$1", [f.orderId]);
    const before = await source(f);
    const co = await upsertLocalCoOrder(f.options);
    const afterState = await assertReleased(f);
    assert.deepEqual(afterState.lines.map(protectedLine), before.lines.map(protectedLine));
    const detail = await getDeliveryOrder(co.co_ref);
    await setDeliveryLinePackedQuantity(co.delivery_order_id, detail.lines[0].id, { pieces: 4 }, f.operator.id);
    assert.equal(Number((await getDeliveryOrder(co.co_ref)).lines[0].packed_piece_qty), 4);
  }), { seed: 8838, numRuns: 25 });
}));

test("handoff waits for a concurrent operator update and releases its committed packing", async () => {
  const f = await fixture();
  const client = await pool.connect();
  let operation;
  let pid;
  let waiting = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${f.orderId}`]);
    await client.query("UPDATE sales_order_lines SET packed_piece_qty=17 WHERE id=$1", [f.lineId]);
    operation = withTransaction(async () => {
      pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return upsertLocalCoOrder(f.options);
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (pid) {
        waiting = (await client.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
        if (waiting) {break;}
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.query("COMMIT");
    await operation;
    assert.equal(waiting, true);
    await assertReleased(f);
    const audit = (await query("SELECT details FROM delivery_audit_log WHERE action='delivery.co.source_packing.released' AND order_id=$1", [f.orderId])).rows[0];
    assert.equal(Number(audit.details.lines[0].packed_piece_qty), 17);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await operation?.catch(() => null);
    await query("DELETE FROM local_co_orders WHERE source_order_ref=$1", [f.tranid]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=$1", [f.orderId]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=$1", [f.orderId]);
  }
});
