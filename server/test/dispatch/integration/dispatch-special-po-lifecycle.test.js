import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { assertNoDriverPwaCompletedDispatchRefs } from "../../../src/dispatch-history-mode.js";
import { overlayDispatchOrderCompletionStatuses } from "../../../src/dispatch-completion-repository.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";

after(closeDb);
const PO_ID = 9359250001;
const PO_REF = "TEST-LOINC-035925";
const GROUP = "TEST-GOA-9261-9263";
const SO_REFS = ["TEST-SOA09261", "TEST-SOA09263"];
const FINISHED = "2026-09-25T19:25:43.188Z";
const migrationPath = new URL("../../../migrations/213_dispatch_special_po_link_coverage.sql", import.meta.url);
const previousMigrationPath = new URL("../../../migrations/182_dispatch_direct_po_link_execution.sql", import.meta.url);

async function rollbackTest(run) {
  const context = await beginRollbackContext();
  try { await context.run(run); } finally { await context.rollback(); }
}

async function seed({ salesQty = 1063.81 } = {}) {
  await query(`INSERT INTO purchase_orders (
    netsuite_id, tranid, dispatch_ref, trandate, vendor, status, status_text,
    destination_location_id, destination_location, dispatch_vendor_yard,
    receipt_status, initial_scm_status, netsuite_active
  ) VALUES ($1, 'TEST-POB03921', $2, '2026-09-25', 'Test Vendor', 'B',
    'Purchase Order : Pending Receipt', 15, '2967', 'Test Vendor Yard',
    'not_received', 'Queued', true)`, [PO_ID, PO_REF]);
  for (const [index, itemId, quantity, pallets, unit] of [
    [0, 2055, 1063.81, 11, "SQFT"], [1, 1784, 11, 0, "EACH"]
  ]) {
    const name = index ? "PALLET" : "MBBS-Special Order";
    const poLine = await query(`INSERT INTO purchase_order_lines (
      purchase_order_id, line_id, item_id, item_name, sku, item_type, quantity,
      unit, pallet_qty, location_id, location, netsuite_active
    ) VALUES ($1, $2, $3, $4, $4, 'NonInvtPart', $5, $6, $7, 15, '2967', true)
    RETURNING id`, [PO_ID, index + 1, itemId, name, quantity, unit, pallets]);
    const soId = PO_ID + 10 + index;
    await query(`INSERT INTO sales_orders (
      netsuite_id, tranid, trandate, customer, status, status_text, sales_order_type,
      outbound_location_id, outbound_location, fulfillment_status, netsuite_active
    ) VALUES ($1, $2, '2026-09-25', 'Test Customer', 'B',
      'Sales Order : Pending Fulfillment', 'Delivery', 15, '2967', 'open', true)`, [soId, SO_REFS[index]]);
    const soLine = await query(`INSERT INTO sales_order_lines (
      sales_order_id, line_id, item_id, item_name, sku, item_type, quantity,
      unit, pallet_qty, netsuite_active
    ) VALUES ($1, $2, $3, $4, $4, 'NonInvtPart', $5, $6, $7, true)
    RETURNING id`, [soId, index + 1, itemId, name, quantity, unit, pallets]);
    await query(`INSERT INTO dispatch_so_po_allocations (
      sales_order_id, sales_order_ref, sales_line_id, po_order_id, po_order_ref,
      po_line_id, item_id, item_name, sku, allocated_sales_qty,
      dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, 'group', $11, 'test')`,
    [soId, SO_REFS[index], soLine.rows[0].id, PO_ID, PO_REF, poLine.rows[0].id,
      itemId, name, index ? quantity : salesQty, GROUP, `${GROUP}::${SO_REFS[index]}::${soLine.rows[0].id}`]);
  }
  const plan = (await query(`INSERT INTO dispatch_plans (plan_date, status, note)
    VALUES ('2026-09-25', 'confirmed', 'special PO lifecycle test') RETURNING id`)).rows[0];
  for (const ref of SO_REFS) {
    await query(`INSERT INTO dispatch_plan_order_assignments (
      plan_id, plan_date, order_ref, planned_order_ref, assignment_kind, load_id, stop_id, assignment
    ) VALUES ($1, '2026-09-25', $2, $3, 'direct', 'load-3', 'drop-3', $4::jsonb)`,
    [plan.id, ref, GROUP, JSON.stringify({ dispatchPlanned: true, dispatchPlanId: String(plan.id),
      dispatchPlanDate: "2026-09-25", dispatchTruckPlate: "TEST-BC71838",
      dispatchLoadName: "Load 3", dispatchDriverName: "Test Driver" })]);
  }
  return plan;
}

async function complete(plan, { refs = SO_REFS, stopType = "dropoff", jobId = "special-drop" } = {}) {
  await query(`INSERT INTO driver_job_records (
    job_id, plan_id, plan_date, driver_login, truck_plate, load_id, load_name,
    stop_id, stop_type, order_refs, status, started_at, completed_at, job_details
  ) VALUES ($1, $2, '2026-09-25', 'test-driver', 'TEST-BC71838', 'load-3', 'Load 3',
    $1, $3, $4::jsonb, 'complete', '2026-09-25T18:12:57Z', $5, $6::jsonb)`,
  [jobId, plan.id, stopType, JSON.stringify(refs), FINISHED,
    JSON.stringify({ orderTypes: ["SO"], orders: refs.map((orderRef) => ({ orderRef, orderType: "SO" })) })]);
}

async function poCompletion() {
  return (await query("SELECT * FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=$1", [PO_REF])).rows;
}

test("fully linked native special PO inherits Planned from GOA target", () => rollbackTest(async () => {
  await seed();
  const schedule = (await listScmSchedule({ exactRef: PO_REF, audience: "scm" })).find((row) => row.orderRef === PO_REF);
  assert.equal(schedule?.calculatedStatus, "Planned");
  assert.equal(schedule.driver, "Test Driver");
  assert.equal((await poCompletion()).length, 0);
}));

test("LOINC native special completion reaches SCM and rejects duplicate planning", () => rollbackTest(async () => {
  const plan = await seed();
  await complete(plan);
  const rows = await poCompletion();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].completion_evidence_type, "driver_job");
  assert.equal(rows[0].completion_evidence_id, "special-drop");
  assert.equal(new Date(rows[0].dispatch_completed_at).toISOString(), FINISHED);
  const schedule = (await listScmSchedule({ exactRef: PO_REF, status: ["Completed"], audience: "scm" }))
    .find((row) => row.orderRef === PO_REF);
  assert.equal(schedule?.calculatedStatus, "Completed");
  const [projected] = await overlayDispatchOrderCompletionStatuses([{ id: PO_REF, type: "PO", scm: { status: "Queued" } }]);
  assert.equal(projected.scm.status, "Completed");
  assert.equal(projected.dispatchCompletedAt, FINISHED);
  assert.equal(projected.dispatchPlanningRestricted, true);
  await assert.rejects(assertNoDriverPwaCompletedDispatchRefs([PO_REF]), { code: "DISPATCH_ORDER_DRIVER_COMPLETED" });
  await assert.rejects(assertNoDriverPwaCompletedDispatchRefs(["TEST-POB03921"]), { code: "DISPATCH_ORDER_DRIVER_COMPLETED" });
}));

test("pickup and one SO drop cannot complete a fully linked two-SO PO", () => rollbackTest(async () => {
  const plan = await seed();
  await complete(plan, { stopType: "pickup", jobId: "special-pickup" });
  assert.equal((await poCompletion()).length, 0);
  await complete(plan, { refs: [SO_REFS[0]], jobId: "first-drop" });
  assert.equal((await poCompletion()).length, 0);
  await complete(plan, { refs: [SO_REFS[1]], jobId: "second-drop" });
  assert.equal((await poCompletion()).length, 1);
}));

test("partial native link cannot complete a PO or hide its outstanding route", () => rollbackTest(async () => {
  const plan = await seed({ salesQty: 1000 });
  await complete(plan);
  assert.equal((await poCompletion()).length, 0);
  const covered = (await query("SELECT dispatch_po_link_fully_covers($1) AS covered", [PO_ID])).rows[0].covered;
  assert.equal(covered, false);
  assert.equal(await assertNoDriverPwaCompletedDispatchRefs([PO_REF]), true);
}));

test("historical migration recovers exact Driver evidence once without rewriting source history", () => rollbackTest(async () => {
  const previous = await readFile(previousMigrationPath, "utf8");
  const oldFunction = previous.slice(previous.indexOf("CREATE OR REPLACE FUNCTION dispatch_po_link_fully_covers"),
    previous.indexOf("CREATE OR REPLACE FUNCTION dispatch_project_direct_po_link_completion"));
  await query(oldFunction);
  const plan = await seed();
  await complete(plan);
  assert.equal((await poCompletion()).length, 0, "fixture reproduces the previous production predicate");
  const snapshot = async () => (await query(`SELECT jsonb_build_object(
    'lines', (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM purchase_order_lines l WHERE purchase_order_id=$1),
    'allocations', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM dispatch_so_po_allocations a WHERE po_order_id=$1),
    'jobs', (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM driver_job_records j WHERE plan_id=$2)
  ) AS value`, [PO_ID, plan.id])).rows[0].value;
  const before = await snapshot();
  const migration = await readFile(migrationPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") { return previous; }
    throw error;
  });
  const sql = migration.replace(/^BEGIN;\s*/u, "").replace(/\s*COMMIT;\s*$/u, "");
  await query(sql);
  const recovered = await poCompletion();
  assert.equal(recovered.length, 1);
  assert.equal(new Date(recovered[0].dispatch_completed_at).toISOString(), FINISHED);
  assert.equal(recovered[0].completion_evidence_id, "special-drop");
  await query(sql);
  const count = await query("SELECT count(*)::int AS count FROM dispatch_order_completion_events WHERE order_kind='PO' AND order_ref=$1", [PO_REF]);
  assert.equal(count.rows[0].count, 1);
  assert.deepEqual(await snapshot(), before);
}));
