import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before, after } from "node:test";
import fc from "fast-check";
import { beginRollbackContext, closeDb, query, withTransaction } from "../../../src/db.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "../../../src/scm-reconciliation-repository.js";

const PO_ID = 9971103001;
const PO = "SN-GROUP-LIFECYCLE-TEST";
const SO = "SO-GROUP-LIFECYCLE-TEST";
const GROUP = "GO-GROUP-LIFECYCLE-TEST";
const PICKUP = "2026-10-02T12:56:13.770Z";
const FIRST = "2026-10-02T16:32:30.332Z";
const LAST = "2026-10-02T17:32:30.332Z";
const migration = new URL("../../../migrations/257_direct_linked_po_group_completion.sql", import.meta.url);

before(async () => {
  for (const file of ["253_direct_ship_netsuite_posting.sql", "256_direct_linked_po_transport_lifecycle.sql"]) {
    await query(await readFile(new URL("../../../migrations/" + file, import.meta.url), "utf8"));
  }
  if (process.env.DIRECT_LINKED_PO_GROUP_BASELINE !== "1") { await query(await readFile(migration, "utf8")); }
  if (process.env.DIRECT_PO_SPLIT_BASELINE !== "1") {
    await query(await readFile(new URL("../../../migrations/291_direct_po_materialized_split_status.sql", import.meta.url), "utf8"));
  }
});
after(closeDb);

async function rollbackTest(run) {
  const context = await beginRollbackContext();
  try { await context.run(run); } finally { await context.rollback(); }
}

async function seed({ amounts = [40, 60], allocated = amounts.reduce((a, b) => a + b, 0), linkPallet = false } = {}) {
  const quantity = amounts.reduce((a, b) => a + b, 0);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,vendor,status,status_text,
    destination_location_id,destination_location,initial_scm_status,netsuite_active)
    VALUES($1,$2,'Group Test Vendor','B','Pending Receipt',15,'12441','Queued',true)`, [PO_ID, PO]);
  await query("INSERT INTO scm_transport_schedule(order_kind,order_ref,status) VALUES('PO',$1,'Queued')", [PO]);
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2026-10-02','confirmed') RETURNING id")).rows[0];
  const details = [];
  const refs = [];
  for (const [index, item, qty, activeLink] of [[0, 2055, quantity, true], [1, 1784, 1, linkPallet]]) {
    const name = index ? "PALLET" : "MBBS-Special Order";
    const unit = index ? "EACH" : "SQFT";
    const line = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,
      item_name,sku,item_description,item_type,unit,quantity,netsuite_active)
      VALUES($1,$2,$3,$4,$4,$4,$5,$6,$7,true) RETURNING id`,
    [PO_ID,index + 1,item,name,index ? "InvtPart" : "NonInvtPart",unit,qty])).rows[0];
    if (!activeLink) { continue; }
    const soId = PO_ID + 10 + index;
    const root = index ? SO + "-PALLET" : SO;
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,
      outbound_location_id,outbound_location,netsuite_active)
      VALUES($1,$2,'Group Test Customer','B','Pending Fulfillment',15,'12441',true)`, [soId,root]);
    const salesLine = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,
      item_name,sku,item_type,unit,quantity,netsuite_active)
      VALUES($1,1,$2,$3,$3,$4,$5,$6,true) RETURNING id`,
    [soId,item,name,index ? "InvtPart" : "NonInvtPart",unit,qty])).rows[0];
    await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
      po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,
      dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'group',$10)`,
    [soId,root,salesLine.id,PO_ID,PO,line.id,item,index ? qty : allocated,GROUP,`${GROUP}::${root}::${salesLine.id}`]);
    for (const [position, part] of (index ? [qty] : amounts).entries()) {
      const childId = -(PO_ID + 100 + index * 10 + position);
      const ref = `${root}-S${position + 1}`;
      await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,
        outbound_location_id,outbound_location,netsuite_active)
        VALUES($1,$2,'Group Test Customer','B','Pending Fulfillment',15,'12441',true)`, [childId,ref]);
      await query(`INSERT INTO dispatch_scm_so_splits(source_so_id,source_so_ref,split_so_id,split_so_ref)
        VALUES($1,$2,$3,$4)`, [soId,root,childId,ref]);
      details.push({ id: ref, type: "SO", items: [{ lineRowId: salesLine.id, itemId: item, quantity: part, splitQty: part, unit }] });
      if (!index) { refs.push(ref); }
    }
  }
  const full = { id: GROUP, type: "SO", childOrders: details.map(row => row.id), childOrderDetails: details };
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
    VALUES($1,'SO',$2,'2026-10-02',$3::jsonb,$3::jsonb)`, [GROUP,plan.id,JSON.stringify(full)]);
  for (const [position, detail] of details.entries()) {
    await query("INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES($1,$2,$3)", [GROUP,detail.id,position]);
  }
  return { plan, refs, details };
}

async function job(plan, { refs, stop = "dropoff", at = FIRST, kind = "SO", name = refs.join("-") + stop } = {}) {
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,load_id,
    stop_id,stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,'2026-10-02','group-test-driver','group-test-load',$1,$3,$4::jsonb,'complete',$5,$6::jsonb)`,
  [name,plan.id,stop,JSON.stringify(refs),at,JSON.stringify({ orderTypes: [kind], orders: refs.map(ref => ({ orderRef: ref, orderType: kind })) })]);
}

async function completion() {
  return (await query("SELECT * FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=$1", [PO])).rows[0];
}
async function schedule(options = {}) { return listScmSchedule({ exactRefs: [PO], ...options }); }
async function receipts() { return (await query("SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1", [PO_ID])).rows; }

test("grouped split pickup projects In Transit through filtered and enriched schedule rows", () => rollbackTest(async () => {
  const { plan, refs } = await seed();
  await job(plan, { refs: [refs[0]], stop: "pickup", at: PICKUP });
  assert.equal((await schedule())[0].calculatedStatus, "In Transit");
  assert.equal((await schedule({ status: "In Transit" }))[0].orderRef, PO);
  assert.equal((await enrichScmScheduleWithReconciliation(await schedule()))[0].calculatedStatus, "In Transit");
  assert.equal(await completion(), undefined);
}));

test("every grouped product split must arrive before completion at the final Driver time", () => rollbackTest(async () => {
  const { plan, refs } = await seed();
  await job(plan, { refs: [refs[0]] });
  assert.equal(await completion(), undefined);
  assert.equal((await schedule())[0].calculatedStatus, "Partially Done");
  await job(plan, { refs: [refs[1]], at: LAST });
  const done = await completion();
  assert.ok(done, "group split references must establish the PO's completed delivery");
  assert.equal(new Date(done.dispatch_completed_at).toISOString(), LAST);
  assert.equal((await schedule())[0].dispatchCompletedAt, LAST);
  assert.equal((await receipts()).length, 0);
}));

test("SN1401884 shape: a grouped product split and linked PALLET split complete without new receipt admission", () => rollbackTest(async () => {
  const { plan, details } = await seed({ amounts: [1860], linkPallet: true });
  assert.equal((await query("SELECT dispatch_po_link_fully_covers($1) AS covered", [PO_ID])).rows[0].covered, true);
  await job(plan, { refs: details.map(detail => detail.id) });
  const done = await completion();
  assert.ok(done, "delivered group children must complete the fully linked PO");
  assert.equal(new Date(done.dispatch_completed_at).toISOString(), FIRST);
  assert.equal(done.metadata.directShipCoverageVerified, false);
  assert.equal(done.metadata.directTransportCoverageVerified, true);
  assert.equal((await schedule({ statusProjectionOnly: true }))[0].calculatedStatus, "Completed");
  assert.equal((await receipts()).length, 0);
}));

test("an unrelated split or completed root SO cannot complete this group's pending child", () => rollbackTest(async () => {
  const { plan, refs } = await seed({ amounts: [100] });
  await job(plan, { refs: [SO, SO + "-S99"] });
  assert.equal(await completion(), undefined);
  assert.equal((await schedule())[0].calculatedStatus, "Direct ship");
  await job(plan, { refs });
  assert.ok(await completion());
}));

test("group definitions with wrong line identity or insufficient quantity cannot establish delivery", () => rollbackTest(async () => {
  const { plan, refs } = await seed({ amounts: [100] });
  const original = (await query("SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1", [GROUP])).rows[0].full_order;
  const wrong = structuredClone(original);
  wrong.childOrderDetails[0].items[0].lineRowId = "unrelated-line";
  await query("UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1", [GROUP,JSON.stringify(wrong)]);
  await job(plan, { refs });
  assert.equal(await completion(), undefined);
  const short = structuredClone(original);
  short.childOrderDetails[0].items[0].quantity = 99;
  short.childOrderDetails[0].items[0].splitQty = 99;
  await query("UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1", [GROUP,JSON.stringify(short)]);
  await job(plan, { refs, name: "short-group" });
  assert.equal(await completion(), undefined);
  const missing = structuredClone(original);
  delete missing.childOrderDetails;
  await query("UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1", [GROUP,JSON.stringify(missing)]);
  await job(plan, { refs, name: "missing-group-children" });
  assert.equal(await completion(), undefined);
}));

for (const cause of ["wrong Driver kind", "cancelled allocation", "unfinished product quantity"]) {
  test(`group completion rejects ${cause}`, () => rollbackTest(async () => {
    const { plan, refs } = await seed({ allocated: cause === "unfinished product quantity" ? 95 : 100 });
    if (cause === "cancelled allocation") { await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE po_order_id=$1", [PO_ID]); }
    await job(plan, { refs, kind: cause === "wrong Driver kind" ? "PO" : "SO" });
    assert.equal(await completion(), undefined);
    assert.equal((await receipts()).length, 0);
    if (cause === "unfinished product quantity") { assert.equal((await schedule())[0].calculatedStatus, "Partially Done"); }
  }));
}

test("historical group recovery retains exact Driver proof, source data, rollback and idempotence", () => rollbackTest(async () => {
  const { plan, refs } = await seed();
  // Suppress only the projection trigger to reproduce a genuinely completed
  // pre-fix group; Driver's own canonical SO completion trigger stays active.
  await query("ALTER TABLE driver_job_records DISABLE TRIGGER trg_driver_job_z_direct_po_link_completion");
  try { await job(plan, { refs }); } finally { await query("ALTER TABLE driver_job_records ENABLE TRIGGER trg_driver_job_z_direct_po_link_completion"); }
  const snapshot = async () => (await query(`SELECT jsonb_build_object(
    'header',(SELECT to_jsonb(po) FROM purchase_orders po WHERE netsuite_id=$1),
    'lines',(SELECT jsonb_agg(to_jsonb(line) ORDER BY id) FROM purchase_order_lines line WHERE purchase_order_id=$1),
    'links',(SELECT jsonb_agg(to_jsonb(link) ORDER BY id) FROM dispatch_so_po_allocations link WHERE po_order_id=$1),
    'driver',(SELECT jsonb_agg(to_jsonb(job) ORDER BY id) FROM driver_job_records job WHERE driver_login='group-test-driver')
  ) AS data`, [PO_ID])).rows[0].data;
  const original = await snapshot();
  await withTransaction(async () => {
    await query("SELECT dispatch_recover_direct_po_transport_completion($1)", [PO_ID]);
    assert.ok(await completion());
  }, { rollback: true });
  assert.equal(await completion(), undefined);
  await query("SELECT dispatch_recover_direct_po_transport_completion($1)", [PO_ID]);
  const first = await completion();
  assert.ok(first);
  await query("SELECT dispatch_recover_direct_po_transport_completion($1)", [PO_ID]);
  assert.equal((await completion()).completion_event_id, first.completion_event_id);
  assert.equal(new Date(first.dispatch_completed_at).toISOString(), FIRST);
  assert.deepEqual(await snapshot(), original);
  assert.equal((await receipts()).length, 0);
}));

test("native group quantities conserve completion and partial progress in either delivery order", () => rollbackTest(async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 10, max: 10000 }), fc.boolean(), async (whole, reverse) => {
    await withTransaction(async () => {
      const { plan, refs } = await seed({ amounts: [whole * 0.4, whole * 0.6] });
      const order = reverse ? [...refs].reverse() : refs;
      await job(plan, { refs: [order[0]] });
      assert.equal(await completion(), undefined);
      assert.equal((await schedule())[0].calculatedStatus, "Partially Done");
      await job(plan, { refs: [order[1]], at: LAST });
      assert.equal(new Date((await completion()).dispatch_completed_at).toISOString(), LAST);
      assert.equal((await receipts()).length, 0);
    }, { rollback: true });
    await withTransaction(async () => {
      const { plan, refs } = await seed({ amounts: [whole * 0.4, whole * 0.6] });
      const full = (await query("SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1", [GROUP])).rows[0].full_order;
      full.childOrderDetails[1].items[0].quantity -= 1;
      full.childOrderDetails[1].items[0].splitQty -= 1;
      await query("UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1", [GROUP,JSON.stringify(full)]);
      await job(plan, { refs });
      assert.equal(await completion(), undefined, "stale child quantities cannot cover the linked product");
      assert.equal((await receipts()).length, 0);
    }, { rollback: true });
  }), { numRuns: 20, seed: 261002, endOnFailure: true });
}));
