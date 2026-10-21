import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import fc from "fast-check";
import { closeDb, pool, query, withTransaction } from "../../../src/db.js";
import { previewOperatorOrderReopen, reopenOperatorOrder, searchOperatorReopenOrders } from "../../../src/operator-order-reopen-repository.js";
import { getDeliveryOrder, setDeliveryLinePackedQuantity, confirmCustomerPickupLine } from "../../../src/delivery-repository.js";
import { startDriverJob } from "../../../src/driver-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { previewScmDependencyMutation } from "../../../src/scm-dependency-preview-service.js";
import { reopenFixture, localFields, packedFields, resetInput, state, seedReopenGroup } from "../../support/control-order-reopen-fixture.mjs";

after(closeDb);
const rollback = run => withTransaction(run, { rollback: true });

for (const kind of ["sales_order", "transfer_order"]) {
  test(`${kind}: Control clears every local progress field and preserves photos, ordered lines and assignments`, () => rollback(async () => {
    const f = await reopenFixture({ kind });
    const initial = await state(f);
    const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
    assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
    assert.equal(preview.orders[0].orderRef, f.ref);
    assert.equal(preview.orders[0].operator.displayName, "Pat Packer");
    assert.equal(preview.retainedPhotoCount, 2);
    const result = await reopenOperatorOrder(resetInput(f, preview));
    assert.equal(result.status, "open");
    assert.deepEqual(result.orderRefs, [f.ref]);
    assert.equal(result.retainedPhotoCount, 2);
    const final = await state(f);
    assert.equal(final.header[f.status], "open");
    assert.equal(final.header.local_yard_order_status, "Open");
    assert.equal(final.header.preparing_operator_id, null);
    assert.equal(final.header.preparing_started_at, null);
    for (const line of final.lines) {
      for (const field of [...packedFields, "loaded_qty"]) { assert.equal(Number(line[field]), 0, field); }
      assert.equal(line.confirmed, false);
      assert.equal(line.confirmed_at, null);
      assert.equal(line.loaded_uom, null);
    }
    const protectedLine = line => Object.fromEntries(Object.entries(line).filter(([key]) => !localFields.includes(key)));
    assert.deepEqual(final.lines.map(protectedLine), initial.lines.map(protectedLine));
    assert.deepEqual((await query("SELECT * FROM operator_load_records WHERE id=$1", [f.record.id])).rows[0], f.record);
    const detail = await getDeliveryOrder(f.id);
    assert.deepEqual(detail.operatorReopen.retainedPhotoReferences, f.photos);
    const corrections = (await query("SELECT * FROM operator_order_reopens WHERE target_ref=$1", [f.ref])).rows;
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].actor_operator_id, f.actor.id);
    assert.equal(corrections[0].before_state[0].header[f.status], "packed");
  }));
}

test("stale Open header with loaded lines becomes linkable after reopening", () => rollback(async () => {
  const f = await reopenFixture();
  await query("UPDATE sales_orders SET operator_status='open',local_yard_order_status='Open',preparing_operator_id=null WHERE netsuite_id=$1", [f.id]);
  const command = { action: "link_po", targetRef: f.ref, payload: { poRef: "SN1402415" } };
  const blocked = await previewScmDependencyMutation(command);
  const activity = blocked.blockers.find(row => row.code === "OPERATOR_ACTIVITY_STARTED");
  assert.ok(activity);
  assert.match(activity.message, new RegExp(f.ref));
  assert.match(activity.message, /loaded.*Pat Packer/u);
  assert.equal(activity.details.orders[0].operator.username, f.packer.username);
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  await reopenOperatorOrder(resetInput(f, preview));
  assert.equal((await previewScmDependencyMutation(command)).allowed, true);
}));

test("packing-only progress still allows PO links and date planning", () => rollback(async () => {
  const f = await reopenFixture({ loaded: 0 });
  const preview = await previewScmDependencyMutation({ action: "link_po", targetRef: f.ref, payload: { poRef: "SN1402415" } });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
}));

test("exact retry returns the original correction without clearing newly packed work", () => rollback(async () => {
  const f = await reopenFixture();
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  const input = resetInput(f, preview);
  const result = await reopenOperatorOrder(input);
  await setDeliveryLinePackedQuantity(f.id, f.line.id, { pieces: 3 }, f.packer.id);
  const repacked = await state(f);
  assert.deepEqual(await reopenOperatorOrder(input), result);
  assert.deepEqual(await state(f), repacked);
  assert.equal((await query("SELECT id FROM operator_order_reopens WHERE target_ref=$1", [f.ref])).rowCount, 1);
  await assert.rejects(() => reopenOperatorOrder({ ...input, reason: "Different reason" }), { code: "OPERATOR_REOPEN_REQUEST_REUSED" });
}));

test("preview fences concurrent quantities and retained photo changes", () => rollback(async () => {
  const f = await reopenFixture();
  for (const change of [
    () => query("UPDATE sales_order_lines SET packed_piece_qty=packed_piece_qty+1 WHERE id=$1", [f.line.id]),
    () => query("UPDATE operator_load_records SET photo_data_urls=photo_data_urls || '[\"r2://new-proof.jpg\"]'::jsonb WHERE id=$1", [f.record.id])
  ]) {
    const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
    await change();
    const changed = await state(f);
    await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview)), { code: "OPERATOR_REOPEN_STALE" });
    assert.deepEqual(await state(f), changed);
  }
}));

for (const [label, patch] of [
  ["NetSuite fulfillment", "last_item_fulfillment_id=123,fulfilled_at=now()"],
  ["closed order", "status='H',status_text='Sales Order : Closed'"],
  ["inactive order", "netsuite_active=false"]
]) {
  test(`${label} prevents a full local reset`, () => rollback(async () => {
    const f = await reopenFixture();
    await query(`UPDATE sales_orders SET ${patch} WHERE netsuite_id=$1`, [f.id]);
    const initial = await state(f);
    const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
    assert.equal(preview.allowed, false);
    assert.ok(preview.blockers[0].message.includes(f.ref));
    await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview)), error => error.status === 409);
    assert.deepEqual(await state(f), initial);
  }));
}

test("Control yard authorization fails closed for every group member", () => rollback(async () => {
  const first = await reopenFixture();
  const other = await reopenFixture({ yard: 26 });
  const orderRef = `${first.ref}+${other.ref}`;
  const input = { orderRef, actor: first.actor };
  await assert.rejects(() => previewOperatorOrderReopen(input), { status: 403 });
  await assert.rejects(() => searchOperatorReopenOrders({ search: other.ref, actor: { ...first.actor, yardLocationIds: [] } }), { status: 403 });
  await assert.rejects(() => previewOperatorOrderReopen({ ...input, actor: first.packer }), { status: 403 });
  const admin = { ...first.actor, role: "admin", roles: ["admin"] };
  const preview = await previewOperatorOrderReopen({ orderRef, actor: admin });
  assert.equal(preview.orders.length, 2);
  const result = await reopenOperatorOrder(resetInput(first, preview, { orderRef, actor: admin }));
  assert.equal(result.orderRefs.length, 2);
  assert.equal((await state(first)).header.operator_status, "open");
  assert.equal((await state(other)).header.operator_status, "open");
}));

test("an Operator with the correct yard still cannot search, preview or reopen in Control", () => rollback(async () => {
  const f = await reopenFixture();
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  const initial = await state(f);
  await assert.rejects(() => searchOperatorReopenOrders({ search: f.ref, actor: f.packer }), { status: 403, code: "OPERATOR_REOPEN_FORBIDDEN" });
  await assert.rejects(() => previewOperatorOrderReopen({ orderRef: f.ref, actor: f.packer }), { status: 403, code: "OPERATOR_REOPEN_FORBIDDEN" });
  await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview, { actor: f.packer })), { status: 403, code: "OPERATOR_REOPEN_FORBIDDEN" });
  assert.deepEqual(await state(f), initial);
}));

test("audit failure rolls back every member in a group", () => rollback(async () => {
  const first = await reopenFixture();
  const other = await reopenFixture();
  const orderRef = `${first.ref}+${other.ref}`;
  const initial = [await state(first), await state(other)];
  const preview = await previewOperatorOrderReopen({ orderRef, actor: first.actor });
  await query(`CREATE FUNCTION pg_temp.reject_reopen_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='operator.order.reopen' THEN RAISE EXCEPTION 'Injected audit failure'; END IF; RETURN NEW; END $$`);
  await query("CREATE TRIGGER test_reopen_audit BEFORE INSERT ON delivery_audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_reopen_audit()");
  await assert.rejects(() => reopenOperatorOrder(resetInput(first, preview, { orderRef })), /Injected audit failure/u);
  assert.deepEqual([await state(first), await state(other)], initial);
  assert.equal((await query("SELECT id FROM operator_order_reopens WHERE target_ref=$1", [orderRef])).rowCount, 0);
}));

test("reopening TO leaves all receiving-stage quantities intact", () => rollback(async () => {
  const f = await reopenFixture({ kind: "transfer_order" });
  const inbound = (await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,line_stage,item_id,quantity,unit,
    received_pallet_qty,confirmed,confirmed_at,packed_piece_qty,netsuite_active)
    VALUES($1,1,'receiving',889201,20,'PC',0,true,now(),8,true) RETURNING *`, [f.id])).rows[0];
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  await reopenOperatorOrder(resetInput(f, preview));
  assert.deepEqual((await query("SELECT * FROM transfer_order_lines WHERE id=$1", [inbound.id])).rows[0], inbound);
}));

test("blank reason, malformed UUID/hash and unknown order fail without a correction", () => rollback(async () => {
  const f = await reopenFixture();
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  for (const patch of [{ reason: " " }, { reason: "x".repeat(501) }, { requestId: "../bad" }, { expectedStateHash: "bad" }]) {
    await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview, patch)), { status: 400 });
  }
  await assert.rejects(() => previewOperatorOrderReopen({ orderRef: "NO-SUCH-ORDER", actor: f.actor }), { status: 404 });
  assert.equal((await query("SELECT id FROM operator_order_reopens WHERE target_ref=$1", [f.ref])).rowCount, 0);
}));

test("reopen correction is immutable", () => rollback(async () => {
  const f = await reopenFixture();
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  const result = await reopenOperatorOrder(resetInput(f, preview));
  for (const sql of ["UPDATE operator_order_reopens SET reason='replace' WHERE id=$1", "DELETE FROM operator_order_reopens WHERE id=$1"]) {
    await assert.rejects(() => withTransaction(() => query(sql, [result.correctionId])), /immutable/u);
  }
}));

test("property: arbitrary local packed/loaded amounts reset to zero while targets and proof are conserved", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 6, maxLength: 6 }), async amounts => rollback(async () => {
    const f = await reopenFixture();
    await query(`UPDATE sales_order_lines SET packed_pallet_qty=$2,packed_layer_qty=$3,packed_section_qty=$4,
      packed_piece_qty=$5,packed_sales_qty=$6,loaded_qty=$7 WHERE id=$1`, [f.line.id, ...amounts]);
    const initial = await state(f);
    const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
    const result = await reopenOperatorOrder(resetInput(f, preview));
    const final = await state(f);
    for (const key of [...packedFields, "loaded_qty"]) { assert.equal(Number(final.lines[0][key]), 0); }
    assert.equal(Number(final.lines[0].quantity), Number(initial.lines[0].quantity));
    assert.equal(result.retainedPhotoCount, f.photos.length);
  })), { numRuns: 12, seed: 20261012 });
});

test("two real concurrent resets from one preview commit exactly once", async () => {
  const f = await reopenFixture();
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  const results = await Promise.allSettled([reopenOperatorOrder(resetInput(f, preview)), reopenOperatorOrder(resetInput(f, preview))]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(results.find(row => row.status === "rejected").reason.code, "OPERATOR_REOPEN_STALE");
  assert.equal((await query("SELECT id FROM operator_order_reopens WHERE target_ref=$1", [f.ref])).rowCount, 1);
});

test("real Operator packing lock serializes reset and rechecks its fingerprint", async () => {
  const f = await reopenFixture();
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${f.id}`]);
    const pending = reopenOperatorOrder(resetInput(f, preview));
    const rejected = assert.rejects(pending, { code: "OPERATOR_REOPEN_STALE" });
    await client.query("UPDATE sales_order_lines SET packed_piece_qty=9 WHERE id=$1", [f.line.id]);
    await client.query("COMMIT");
    await rejected;
    assert.equal(Number((await state(f)).lines[0].packed_piece_qty), 9);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

test("Customer Pickup packing uses the same lock as Control reset", async () => {
  const f = await reopenFixture({ loaded: 0 });
  await query("UPDATE sales_orders SET sales_order_type='Pick-Up' WHERE netsuite_id=$1", [f.id]);
  const client = await pool.connect();
  let pending;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${f.id}`]);
    let settled = false;
    pending = confirmCustomerPickupLine(f.id, f.line.id, { pieces: 3 }, f.packer.id).then(value => { settled = true; return value; });
    await query("SELECT pg_sleep(0.1)");
    assert.equal(settled, false, "Pickup packing must wait for the shared order lock");
    await client.query("COMMIT");
    await pending;
  } finally { await client.query("ROLLBACK"); client.release(); if (pending) { await pending; } }
});

test("Driver start serializes with Control reset and then prevents a reset", async () => {
  const f = await reopenFixture();
  const client = await pool.connect();
  let pending;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    let settled = false;
    const jobId = `operator-reopen-driver-${crypto.randomUUID()}`;
    const planDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
    pending = startDriverJob("reopen-driver", jobId, { job: { jobId, planDate, orderRefs: [f.ref], stopType: "pickup", location: "3445" } })
      .then(value => { settled = true; return value; });
    await query("SELECT pg_sleep(0.1)");
    assert.equal(settled, false, "Driver start must wait until the reset transaction commits");
    await client.query("COMMIT");
    await pending;
    const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
    assert.equal(preview.allowed, false);
    assert.ok(preview.blockers.some(row => row.code === "OPERATOR_REOPEN_DRIVER_STARTED"));
  } finally { await client.query("ROLLBACK"); client.release(); if (pending) { await pending; } }
});

test("a group membership change while reset waits for an Operator lock leaves every member intact", async () => {
  const first = await reopenFixture(), second = await reopenFixture();
  const groupRef = `GO-RACING-REOPEN-${crypto.randomUUID()}`;
  await seedReopenGroup(groupRef, [first.ref, second.ref]);
  const preview = await previewOperatorOrderReopen({ orderRef: groupRef, actor: first.actor });
  const initial = [await state(first), await state(second)];
  const client = await pool.connect();
  let pending;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${[first.id, second.id].sort()[0]}`]);
    pending = reopenOperatorOrder(resetInput(first, preview, { orderRef: groupRef }));
    const rejected = assert.rejects(pending, error => error.code === "OPERATOR_REOPEN_STALE" && /membership changed/u.test(error.message));
    await query("SELECT pg_sleep(0.1)");
    await client.query("UPDATE dispatch_global_order_groups SET full_order=jsonb_set(full_order,'{childOrders}',$2::jsonb) WHERE group_ref=$1",
      [groupRef, JSON.stringify([first.ref])]);
    await client.query("COMMIT");
    await rejected;
    assert.deepEqual([await state(first), await state(second)], initial);
  } finally { await client.query("ROLLBACK"); client.release(); if (pending) { await pending.catch(() => null); } }
});
