import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { createOperator } from "../../../src/auth-repository.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "../../../src/scm-reconciliation-repository.js";
import {
  getScmSchedulePreference,
  normalizeScmSchedulePreference,
  updateScmSchedulePreference
} from "../../../src/scm-schedule-preference-repository.js";

after(closeDb);

const PO_ID = 9961002001;
const TO_ID = PO_ID + 1;
const SO_ID = PO_ID + 2;
const PO_REF = "SN-DIRECT-SCHEDULE";
const TO_REF = "TO-DIRECT-SCHEDULE";
const SO_REF = "SO-DIRECT-SCHEDULE";
const REFS = [PO_REF, TO_REF];

async function rollbackTest(run) {
  const context = await beginRollbackContext();
  try {
    await context.run(run);
  } finally {
    await context.rollback();
  }
}

async function seed({ allocated = 20, linked = true, mode = "direct_to_customer" } = {}) {
  await query(`INSERT INTO purchase_orders (
    netsuite_id, tranid, dispatch_ref, vendor, status, status_text,
    destination_location_id, destination_location, dispatch_vendor_yard,
    initial_scm_status, netsuite_active
  ) VALUES ($1, 'PO-DIRECT-SCHEDULE', $2, 'Schedule Vendor', 'B', 'Pending Receipt',
    15, '12441', 'Schedule Vendor Yard', 'Queued', true)`, [PO_ID, PO_REF]);
  const poLine = (await query(`INSERT INTO purchase_order_lines (
    purchase_order_id, line_id, item_id, item_name, sku, item_type,
    quantity, piece_qty, to_pcs, unit, netsuite_active
  ) VALUES ($1, 1, 5055, 'Schedule Pieces', 'SCHEDULE-PIECES', 'InvtPart', 20, 20, 1, 'PC', true)
    RETURNING id`, [PO_ID])).rows[0].id;
  await query(`INSERT INTO transfer_orders (
    netsuite_id, tranid, status, status_text, from_location_id, from_location,
    to_location_id, to_location, receiving_status, fulfillment_status, netsuite_active
  ) VALUES ($1, $2, 'B', 'Pending Fulfillment', 28, '2967', 15, '12441', 'not_received', 'open', true)`,
  [TO_ID, TO_REF]);
  const toLines = {};
  for (const stage of ["outbound", "receiving"]) {
    toLines[stage] = (await query(`INSERT INTO transfer_order_lines (
      transfer_order_id, line_stage, line_id, item_id, item_name, sku, item_type,
      quantity, piece_qty, to_pcs, unit, netsuite_active
    ) VALUES ($1, $2, 1, 5055, 'Schedule Pieces', 'SCHEDULE-PIECES', 'InvtPart', 20, 20, 1, 'PC', true)
      RETURNING id`, [TO_ID, stage])).rows[0].id;
  }
  await query(`INSERT INTO sales_orders (
    netsuite_id, tranid, customer, status, status_text,
    outbound_location_id, outbound_location, fulfillment_status, netsuite_active
  ) VALUES ($1, $2, 'Schedule Customer', 'B', 'Pending Fulfillment', 15, '12441', 'open', true)`,
  [SO_ID, SO_REF]);
  const soLine = (await query(`INSERT INTO sales_order_lines (
    sales_order_id, line_id, item_id, item_name, sku, quantity, piece_qty, to_pcs, unit, netsuite_active
  ) VALUES ($1, 1, 5055, 'Schedule Pieces', 'SCHEDULE-PIECES', 40, 40, 1, 'PC', true) RETURNING id`,
  [SO_ID])).rows[0].id;
  for (const [kind, ref] of [["PO", PO_REF], ["TO", TO_REF]]) {
    await query("INSERT INTO scm_transport_schedule (order_kind, order_ref, status, updated_at) VALUES ($1, $2, 'Queued', '2026-09-01')", [kind, ref]);
  }
  if (!linked) {
    return;
  }
  // The historical PO ref deliberately differs from the current dispatch alias.
  await query(`INSERT INTO dispatch_so_po_allocations (
    sales_order_id, sales_order_ref, sales_line_id, po_order_id, po_order_ref, po_line_id,
    item_id, allocated_sales_qty, allocated_piece_qty, dispatch_target_ref, dispatch_target_line_key
  ) VALUES ($1, $2, $3, $4, 'PO-DIRECT-SCHEDULE', $5, 5055, $6, $6, $2, $7)`,
  [SO_ID, SO_REF, soLine, PO_ID, poLine, allocated, `${SO_REF}::${SO_REF}::${soLine}`]);
  const dependency = (await query(`INSERT INTO order_dependencies (
    sales_order_id, sales_order_ref, dispatch_target_ref, transfer_order_id, transfer_order_ref,
    dependency_mode, same_load_required, status, source_location_id, source_location,
    accounting_destination_location_id, accounting_destination_location
  ) VALUES ($1, $2, $2, $3, $4, $5, $6, 'active', 28, '2967', 15, '12441') RETURNING id`,
  [SO_ID, SO_REF, TO_ID, TO_REF, mode, mode === "direct_to_customer"])).rows[0].id;
  await query(`INSERT INTO order_dependency_lines (
    dependency_id, sales_line_id, transfer_outbound_line_id, transfer_receiving_line_id,
    item_id, item_name, unit, allocated_quantity, piece_qty, line_role, dispatch_target_line_key
  ) VALUES ($1, $2, $3, $4, 5055, 'Schedule Pieces', 'PC', $5, $5, 'sales_allocation', $6)`,
  [dependency, soLine, toLines.outbound, toLines.receiving, allocated, `${SO_REF}::${SO_REF}::${soLine}`]);
}

async function rows(options = {}) {
  return listScmSchedule({ exactRefs: REFS, ...options });
}

async function reconcile(applicationStatus = "Queued", reconciliationStatus = "current") {
  for (const [kind, id, ref] of [["PO", PO_ID, PO_REF], ["TO", TO_ID, TO_REF]]) {
    const state = (await query(`INSERT INTO scm_reconciliation_order_state (
      order_kind, source_order_netsuite_id, source_order_ref, application_status,
      reconciliation_status, ordered_qty, remaining_qty, quantity_summary, reconciled_at
    ) VALUES ($1, $2, $3, $4, $5, 20, 20, $6::jsonb, '2026-10-01') RETURNING id`,
    [kind, id, ref, applicationStatus, reconciliationStatus,
      JSON.stringify({ targets: { [ref]: { applicationStatus } } })])).rows[0].id;
    await query(`UPDATE scm_transport_schedule SET reconciliation_order_state_id = $3
      WHERE order_kind = $1 AND order_ref = $2`, [kind, ref, state]);
  }
}

for (const allocated of [20, 5]) {
  test(`PO direct ship and TO direct pickup show Direct ship with ${allocated}/20 linked pieces`, () => rollbackTest(async () => {
    await seed({ allocated });
    const schedule = await rows();
    assert.equal(schedule.length, 2);
    for (const row of schedule) {
      assert.equal(row.status, "Direct ship", row.orderRef);
      assert.equal(row.calculatedStatus, "Direct ship", row.orderRef);
      assert.equal(row.directShipLinked, true);
    }
    assert.deepEqual((await rows({ statusProjectionOnly: true })).map(row => row.calculatedStatus), ["Direct ship", "Direct ship"]);
  }));
}

test("unlinked orders stay queued and cancelled links restore the underlying status", () => rollbackTest(async () => {
  await seed({ linked: false });
  assert.deepEqual((await rows()).map(row => row.calculatedStatus), ["Queued", "Queued"]);
}));

test("unlinking the last direct link restores both PO and TO statuses", () => rollbackTest(async () => {
  await seed();
  assert.equal((await rows({ status: "Direct ship" })).length, 2);
  await query("UPDATE dispatch_so_po_allocations SET status = 'cancelled' WHERE po_order_id = $1", [PO_ID]);
  await query("UPDATE order_dependencies SET status = 'cancelled' WHERE transfer_order_id = $1", [TO_ID]);
  assert.equal((await rows({ status: "Direct ship" })).length, 0);
  assert.deepEqual((await rows()).map(row => row.calculatedStatus), ["Queued", "Queued"]);
}));

test("warehouse TO links keep their normal status and a mode change updates it immediately", () => rollbackTest(async () => {
  await seed({ mode: "yard_replenishment" });
  assert.equal((await rows()).find(row => row.orderKind === "TO").calculatedStatus, "Queued");
  await query("UPDATE order_dependencies SET dependency_mode = 'direct_to_customer' WHERE transfer_order_id = $1", [TO_ID]);
  assert.equal((await rows()).find(row => row.orderKind === "TO").calculatedStatus, "Direct ship");
}));

test("newer Queued reconciliation cannot hide direct links and the server filters on the displayed status", () => rollbackTest(async () => {
  await seed();
  await reconcile();
  const schedule = await rows({ status: "Direct ship" });
  assert.equal(schedule.length, 2);
  const enriched = await enrichScmScheduleWithReconciliation(schedule, { includeDetails: true });
  for (const row of enriched) {
    assert.equal(row.calculatedStatus, "Direct ship");
    assert.equal(row.reconciliationApplicationStatus, "Direct ship");
    assert.equal(row.reconciliation.applicationStatus, "Direct ship");
  }
  assert.equal((await rows({ status: ["Queued", "Planned"] })).length, 0);
}));

test("linked SO plan timing remains available while the PO is Direct ship", () => rollbackTest(async () => {
  await seed();
  const plan = (await query("INSERT INTO dispatch_plans (plan_date, status) VALUES ('2097-09-01', 'confirmed') RETURNING id")).rows[0].id;
  await query(`INSERT INTO dispatch_plan_order_assignments (
    plan_id, plan_date, order_ref, planned_order_ref, assignment_kind, load_id, stop_id, assignment
  ) VALUES ($1, '2097-09-01', $2, $2, 'direct', 'schedule-load', 'schedule-drop', $3::jsonb)`,
  [plan, SO_REF, JSON.stringify({ dispatchOrderKind: "SO", dispatchEtaTime: "10:30", dispatchDriverName: "Schedule Driver" })]);
  const po = (await rows()).find(row => row.orderKind === "PO");
  assert.equal(po.calculatedStatus, "Direct ship");
  assert.equal(po.dispatchPlanned, true);
  assert.equal(po.etaDate, "2097-09-01");
  assert.equal(po.etaTime, "10:30");
  assert.equal(po.driver, "Schedule Driver");
}));

for (const status of ["Hold", "Cancelled", "In Transit", "Partially Done", "Completed", "Reconcile Review"]) {
  test(`${status} takes precedence over Direct ship`, () => rollbackTest(async () => {
    await seed();
    await query("UPDATE scm_transport_schedule SET status = $1 WHERE order_ref = ANY($2::text[])", [status, REFS]);
    assert.deepEqual((await rows()).map(row => row.calculatedStatus), [status, status]);
  }));
}

for (const [applicationStatus, reconciliationStatus] of [["Completed", "current"], ["Queued", "review"], ["In Transit", "current"], ["Partially Done", "current"]]) {
  test(`authoritative ${applicationStatus}/${reconciliationStatus} survives direct-link projection`, () => rollbackTest(async () => {
    await seed();
    await reconcile(applicationStatus, reconciliationStatus);
    const expected = reconciliationStatus === "review" ? "Reconcile Review" : applicationStatus;
    const schedule = await rows();
    assert.deepEqual(schedule.map(row => row.calculatedStatus), [expected, expected]);
    assert.deepEqual((await enrichScmScheduleWithReconciliation(schedule)).map(row => row.calculatedStatus), [expected, expected]);
  }));
}

test("Direct ship is accepted in saved preferences for all schedule audiences", () => {
  for (const surface of ["scm", "dispatch", "sales"]) {
    assert.deepEqual(normalizeScmSchedulePreference({ status: ["Direct ship"] }, { surface }).status, ["Direct ship"]);
  }
});

test("the preference upgrade preserves selections and can be reapplied", () => rollbackTest(async () => {
  const operator = await createOperator({ username: "direct-schedule-upgrade", displayName: "Schedule Test", password: "schedule-test", role: "scm" });
  await updateScmSchedulePreference(operator.id, "scm", { status: ["Queued", "Hold"] });
  const migration = await readFile(new URL("../../../migrations/255_scm_direct_ship_schedule_status.sql", import.meta.url), "utf8");
  await query(migration);
  await query(migration);
  assert.deepEqual((await getScmSchedulePreference(operator.id, "scm")).status, ["Queued", "Hold"]);
  for (const surface of ["scm", "dispatch", "sales"]) {
    await updateScmSchedulePreference(operator.id, surface, { status: ["Direct ship", "Queued"] });
    assert.deepEqual((await getScmSchedulePreference(operator.id, surface)).status, ["Direct ship", "Queued"]);
  }
}));

test("the authenticated schedule API and saved filter return Direct ship for both links", async () => {
  const { app } = await import("../../../src/server.js");
  const operator = await createOperator({ username: "direct-schedule-http", displayName: "Schedule HTTP", password: "schedule-test", role: "scm", roles: ["scm"] });
  let server;
  try {
    await query(await readFile(new URL("../../../migrations/255_scm_direct_ship_schedule_status.sql", import.meta.url), "utf8"));
    await seed();
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: operator.username, password: "schedule-test" }), signal: AbortSignal.timeout(15000)
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const response = await fetch(base + "/api/scm/schedule?status=Direct%20ship", { headers, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const schedule = await response.json();
    for (const ref of REFS) {
      const row = schedule.find(entry => entry.orderRef === ref);
      assert.ok(row, ref);
      assert.equal(row.calculatedStatus, "Direct ship");
    }
    const queued = await fetch(base + "/api/scm/schedule?status=Queued", { headers, signal: AbortSignal.timeout(15000) });
    assert.equal(queued.status, 200);
    assert.equal((await queued.json()).some(row => REFS.includes(row.orderRef)), false);
    const preference = await fetch(base + "/api/scm/schedule-preferences/scm", {
      method: "PUT", headers, body: JSON.stringify({ status: ["Direct ship"] }), signal: AbortSignal.timeout(15000)
    });
    assert.equal(preference.status, 200);
    assert.deepEqual((await preference.json()).status, ["Direct ship"]);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await query("DELETE FROM scm_transport_schedule WHERE order_ref = ANY($1::text[])", [REFS]);
    await query("DELETE FROM sales_orders WHERE netsuite_id = $1", [SO_ID]);
    await query("DELETE FROM purchase_orders WHERE netsuite_id = $1", [PO_ID]);
    await query("DELETE FROM transfer_orders WHERE netsuite_id = $1", [TO_ID]);
    await query("DELETE FROM operator_sessions WHERE operator_id = $1", [operator.id]);
    await query("DELETE FROM operators WHERE id = $1", [operator.id]);
  }
});
