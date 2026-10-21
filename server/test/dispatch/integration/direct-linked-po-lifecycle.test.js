import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before, after } from "node:test";
import fc from "fast-check";
import { beginRollbackContext, closeDb, query, withTransaction } from "../../../src/db.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "../../../src/scm-reconciliation-repository.js";

const PO_ID = 9971002001;
const PO_REF = "LOINC-LIFECYCLE-TEST";
const SO_REFS = ["SO-LIFECYCLE-1", "SO-LIFECYCLE-2"];
const PICKED = "2026-09-14T16:10:42.660Z";
const FINISHED = "2026-09-14T16:11:31.619Z";
const SECOND_FINISHED = "2026-10-01T17:37:53.866Z";
const migrationPath = new URL("../../../migrations/256_direct_linked_po_transport_lifecycle.sql", import.meta.url);

before(async () => {
  await query(await readFile(new URL("../../../migrations/253_direct_ship_netsuite_posting.sql", import.meta.url), "utf8"));
  if (process.env.DIRECT_LINKED_PO_BASELINE !== "1") {
    await query(await readFile(migrationPath, "utf8"));
  }
});
after(closeDb);

async function rollbackTest(run) {
  const context = await beginRollbackContext();
  try { await context.run(run); } finally { await context.rollback(); }
}

async function seed({ allocated = 100.25, productQuantity = 100.25,
  palletDescription = "**PALLET DEPOSIT** INTERLOCK,CEMENT, CONCRETE",
  feeDescription = "", secondProduct = false, linkPallet = false, standalonePallet = false } = {}) {
  await query(`INSERT INTO purchase_orders (
    netsuite_id,tranid,dispatch_ref,vendor,status,status_text,destination_location_id,
    destination_location,dispatch_vendor_yard,initial_scm_status,netsuite_active
  ) VALUES ($1,'PO-LIFECYCLE-TEST',$2,'Lifecycle Vendor','B','Pending Receipt',15,
    '12441','Lifecycle Pickup','Queued',true)`, [PO_ID, PO_REF]);
  await query("INSERT INTO scm_transport_schedule(order_kind,order_ref,status) VALUES('PO',$1,'Queued')", [PO_REF]);
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2026-09-14','confirmed') RETURNING id")).rows[0];
  const lines = [
    { item: 2055, qty: productQuantity, unit: "SQFT", description: "Blu 60 product", linked: !standalonePallet, so: 0, allocated },
    { item: 1784, qty: 1, unit: "EACH", description: palletDescription, linked: linkPallet || standalonePallet, so: 0, allocated: 1 }
  ];
  if (feeDescription) {
    lines.push({ item: 2055, qty: 1, unit: "EACH", description: feeDescription, linked: false });
  }
  if (secondProduct) {
    lines.push({ item: 2055, qty: 50, unit: "SQFT", description: "Blu 80 product", linked: true, so: 1, allocated: 50 });
  }
  for (let index = 0; index < (secondProduct ? 2 : 1); index += 1) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,
      outbound_location_id,outbound_location,fulfillment_status,netsuite_active)
      VALUES($1,$2,'Lifecycle Customer','B','Pending Fulfillment',15,'12441','open',true)`,
    [PO_ID + 10 + index, SO_REFS[index]]);
  }
  for (const [index, line] of lines.entries()) {
    const name = line.item === 1784 ? "PALLET" : "MBBS-Special Order";
    const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,
      item_id,item_name,sku,item_description,item_type,quantity,unit,pallet_qty,netsuite_active)
      VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,true) RETURNING id`,
    [PO_ID,index + 1,line.item,name,line.description,line.item === 1784 ? "InvtPart" : "NonInvtPart",
      line.qty,line.unit,line.unit === "SQFT" ? 1 : 0])).rows[0];
    if (!line.linked) { continue; }
    const soId = PO_ID + 10 + line.so;
    const soLine = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,
      item_name,sku,quantity,unit,netsuite_active) VALUES($1,$2,$3,$4,$4,$5,$6,true) RETURNING id`,
    [soId,index + 1,line.item,name,line.qty,line.unit])).rows[0];
    await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
      po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,dispatch_target_ref,dispatch_target_line_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$2,$9)`,
    [soId,SO_REFS[line.so],soLine.id,PO_ID,PO_REF,poLine.id,line.item,line.allocated,
      `${SO_REFS[line.so]}::${SO_REFS[line.so]}::${soLine.id}`]);
  }
  return plan;
}

async function job(plan, { ref = SO_REFS[0], type = "dropoff", at = FINISHED, name = `${type}-${ref}` } = {}) {
  return (await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,
    truck_plate,load_id,load_name,stop_id,stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,'2026-09-14','lifecycle-driver','TEST-TRUCK','lifecycle-load','Load 1',$1,$3,
      $4::jsonb,'complete',$5,$6::jsonb) RETURNING id`,
  [name,plan.id,type,JSON.stringify([ref]),at,JSON.stringify({orderTypes:["SO"],orders:[{orderRef:ref,orderType:"SO"}]})])).rows[0];
}

async function completion() {
  return (await query("SELECT * FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=$1", [PO_REF])).rows[0];
}

async function schedule(options = {}) {
  return listScmSchedule({ exactRefs: [PO_REF], ...options });
}

async function receiptJobs() {
  return (await query("SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1", [PO_ID])).rows;
}

test("unlinked pallet deposits follow the fully delivered product at its real completion time", () => rollbackTest(async () => {
  const plan = await seed();
  assert.equal((await schedule())[0].calculatedStatus, "Direct ship");
  await job(plan);
  const done = await completion();
  assert.ok(done, "the completed product delivery must complete this PO");
  assert.equal(new Date(done.dispatch_completed_at).toISOString(), FINISHED);
  assert.equal(done.metadata.directShipCoverageVerified, false);
  assert.equal(done.metadata.directTransportCoverageVerified, true);
  assert.equal((await schedule())[0].calculatedStatus, "Completed");
  assert.equal((await schedule({ statusProjectionOnly: true }))[0].dispatchCompletedAt, FINISHED);
  assert.equal((await schedule({ view: "completed" }))[0].calculatedStatus, "Completed");
  assert.equal((await receiptJobs()).length, 0);
}));

test("split pallet fees and deposits follow every active linked SO; latest delivery sets completion", () => rollbackTest(async () => {
  const plan = await seed({ feeDescription: "SPLIT Pallet Fee", secondProduct: true });
  await job(plan);
  assert.equal(await completion(), undefined, "the second product has not arrived");
  assert.equal((await schedule())[0].calculatedStatus, "Partially Done");
  assert.equal((await schedule({ status: "Partially Done" })).length, 1);
  await job(plan, { ref: SO_REFS[1], at: SECOND_FINISHED });
  const done = await completion();
  assert.ok(done, "ancillary fees must not leave a fully delivered PO open");
  assert.equal(new Date(done.dispatch_completed_at).toISOString(), SECOND_FINISHED);
  assert.equal((await receiptJobs()).length, 0);
}));

test("linked pickup projects In Transit through rows, filters and later Queued reconciliation", () => rollbackTest(async () => {
  const plan = await seed({ linkPallet: true });
  await job(plan, { type: "pickup", at: PICKED });
  assert.equal(await completion(), undefined);
  assert.equal((await schedule())[0].calculatedStatus, "In Transit");
  assert.equal((await schedule())[0].status, "In Transit");
  assert.equal((await schedule({ statusProjectionOnly: true }))[0].calculatedStatus, "In Transit");
  assert.equal((await schedule({ status: "In Transit" })).length, 1);
  assert.equal((await schedule({ status: "Direct ship" })).length, 0);
  const state = (await query(`INSERT INTO scm_reconciliation_order_state(order_kind,source_order_netsuite_id,
    source_order_ref,application_status,reconciliation_status,ordered_qty,remaining_qty,quantity_summary,reconciled_at)
    VALUES('PO',$1,$2,'Queued','current',101.25,101.25,$3::jsonb,now()) RETURNING id`,
  [PO_ID,PO_REF,JSON.stringify({targets:{[PO_REF]:{applicationStatus:"Queued"}}})])).rows[0];
  await query("UPDATE scm_transport_schedule SET reconciliation_order_state_id=$2 WHERE order_ref=$1", [PO_REF,state.id]);
  const rows = await schedule();
  assert.equal(rows[0].calculatedStatus, "In Transit");
  assert.equal((await enrichScmScheduleWithReconciliation(rows))[0].calculatedStatus, "In Transit");
  assert.equal((await receiptJobs()).length, 0);
}));

for (const status of ["Hold", "Cancelled", "Reconcile Review", "Partially Done", "Completed"]) {
  test(`linked pickup preserves ${status} precedence`, () => rollbackTest(async () => {
    const plan = await seed({ linkPallet: true });
    await query("UPDATE scm_transport_schedule SET status=$2 WHERE order_ref=$1", [PO_REF,status]);
    await job(plan, { type: "pickup", at: PICKED });
    assert.equal((await schedule())[0].calculatedStatus, status);
  }));
}

for (const options of [
  { allocated: 95 }, { productQuantity: 0 },
  { feeDescription: "Concrete block EACH product" },
  { standalonePallet: true }
]) {
  test(`unlinked or unknown physical cargo cannot complete: ${JSON.stringify(options)}`, () => rollbackTest(async () => {
    const plan = await seed(options);
    await job(plan);
    assert.equal(await completion(), undefined);
    assert.equal((await receiptJobs()).length, 0);
}));
}

test("PALLET descriptions do not affect product completion status", () => rollbackTest(async () => {
  const plan = await seed({ palletDescription: "Standalone wooden pallet cargo" });
  await job(plan);
  assert.ok(await completion());
  assert.equal((await schedule())[0].calculatedStatus, "Completed");
  assert.equal((await receiptJobs()).length, 0);
}));

test("delivered linked quantity with unfinished product quantity is Partially Done", () => rollbackTest(async () => {
  const plan = await seed({ allocated: 95 });
  await job(plan);
  assert.equal(await completion(), undefined);
  assert.equal((await schedule())[0].calculatedStatus, "Partially Done");
  assert.equal((await schedule({ statusProjectionOnly: true }))[0].calculatedStatus, "Partially Done");
  assert.equal((await schedule({ status: "Completed" })).length, 0);
  assert.equal((await enrichScmScheduleWithReconciliation(await schedule()))[0].calculatedStatus, "Partially Done");
}));

test("ancillary-only pickup shows In Transit and completes only on dropoff", () => rollbackTest(async () => {
  const plan = await seed({ feeDescription: "Split Pallet Fee" });
  await job(plan, { type: "pickup", at: PICKED });
  assert.equal(await completion(), undefined);
  assert.equal((await schedule())[0].calculatedStatus, "In Transit");
  await job(plan);
  assert.equal(new Date((await completion()).dispatch_completed_at).toISOString(), FINISHED);
}));

test("cancelled links supply neither transit nor completion evidence", () => rollbackTest(async () => {
  const plan = await seed({ linkPallet: true });
  await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE po_order_id=$1", [PO_ID]);
  await job(plan, { type: "pickup", at: PICKED });
  await job(plan);
  assert.equal(await completion(), undefined);
  assert.equal((await schedule())[0].calculatedStatus, "Queued");
}));

test("fully linked receipt admission and replay remain unchanged", () => rollbackTest(async () => {
  const plan = await seed({ linkPallet: true });
  const drop = await job(plan);
  const done = await completion();
  assert.equal(done.metadata.directShipCoverageVerified, true);
  assert.equal((await receiptJobs()).length, 1);
  await query("UPDATE driver_job_records SET status='complete' WHERE id=$1", [drop.id]);
  assert.equal((await completion()).completion_event_id, done.completion_event_id);
  assert.equal((await receiptJobs()).length, 1);
}));

test("migration reapplication preserves strict receipt coverage and ancillary completion is replay-safe", () => rollbackTest(async () => {
  const sql = await readFile(migrationPath, "utf8");
  await query(sql);
  await query(sql);
  const plan = await seed();
  const drop = await job(plan);
  const done = await completion();
  assert.equal(done.metadata.directShipCoverageVerified, false);
  await query("UPDATE driver_job_records SET status='complete' WHERE id=$1", [drop.id]);
  assert.equal((await completion()).completion_event_id, done.completion_event_id);
  assert.equal((await receiptJobs()).length, 0);
}));

test("historical transport recovery retains delivery proof, rolls back and repeats without side effects", () => rollbackTest(async () => {
  const plan = await seed({ feeDescription: "Split Pallet Fee", secondProduct: true });
  await query("ALTER TABLE driver_job_records DISABLE TRIGGER trg_driver_job_z_direct_po_link_completion");
  await job(plan);
  await job(plan, { ref: SO_REFS[1], at: SECOND_FINISHED });
  await query("ALTER TABLE driver_job_records ENABLE TRIGGER trg_driver_job_z_direct_po_link_completion");
  assert.equal(await completion(), undefined);
  const beforeSnapshot = (await query(`SELECT jsonb_build_object(
    'lines',(SELECT jsonb_agg(to_jsonb(line) ORDER BY id) FROM purchase_order_lines line WHERE purchase_order_id=$1),
    'allocations',(SELECT jsonb_agg(to_jsonb(allocation) ORDER BY id) FROM dispatch_so_po_allocations allocation WHERE po_order_id=$1),
    'driver',(SELECT jsonb_agg(to_jsonb(job) ORDER BY id) FROM driver_job_records job WHERE plan_id=$2)
  ) AS snapshot`, [PO_ID,plan.id])).rows[0].snapshot;
  const recover = () => query("SELECT dispatch_recover_direct_po_transport_completion($1) AS id", [PO_ID]);
  await withTransaction(async () => {
    await recover();
    assert.ok(await completion(), "historical proof must create the missing PO completion");
    assert.equal(new Date((await completion()).dispatch_completed_at).toISOString(), SECOND_FINISHED);
    assert.equal((await receiptJobs()).length, 0);
  }, { rollback: true });
  assert.equal(await completion(), undefined, "rehearsal must not commit");
  const recovered = (await recover()).rows[0].id;
  assert.ok(recovered);
  assert.equal((await recover()).rows[0].id, recovered);
  assert.equal((await receiptJobs()).length, 0);
  const afterSnapshot = (await query(`SELECT jsonb_build_object(
    'lines',(SELECT jsonb_agg(to_jsonb(line) ORDER BY id) FROM purchase_order_lines line WHERE purchase_order_id=$1),
    'allocations',(SELECT jsonb_agg(to_jsonb(allocation) ORDER BY id) FROM dispatch_so_po_allocations allocation WHERE po_order_id=$1),
    'driver',(SELECT jsonb_agg(to_jsonb(job) ORDER BY id) FROM driver_job_records job WHERE plan_id=$2)
  ) AS snapshot`, [PO_ID,plan.id])).rows[0].snapshot;
  assert.deepEqual(afterSnapshot, beforeSnapshot);
}));

test("native quantity coverage separates Completed from Partially Done across varied balances", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 10000 }), async (quantityCents) => {
    for (const percent of [1, 50, 99, 100]) {
      await rollbackTest(async () => {
        const quantity = quantityCents / 100;
        const allocated = quantity * percent / 100;
        const plan = await seed({ productQuantity: quantity, allocated });
        await job(plan);
        const done = await completion();
        const expected = percent === 100 ? "Completed" : "Partially Done";
        assert.equal(Boolean(done), percent === 100);
        assert.equal((await schedule())[0].calculatedStatus, expected);
        assert.equal((await receiptJobs()).length, 0);
      });
    }
  }), { numRuns: 20, seed: 20261002 });
});
