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

async function seed({ salesQty = 1063.81, secondProduct = false } = {}) {
  await query(`INSERT INTO purchase_orders (
    netsuite_id, tranid, dispatch_ref, trandate, vendor, status, status_text,
    destination_location_id, destination_location, dispatch_vendor_yard,
    receipt_status, initial_scm_status, netsuite_active
  ) VALUES ($1, 'TEST-POB03921', $2, '2026-09-25', 'Test Vendor', 'B',
    'Purchase Order : Pending Receipt', 15, '2967', 'Test Vendor Yard',
    'not_received', 'Queued', true)`, [PO_ID, PO_REF]);
  for (const [index, itemId, quantity, pallets, unit] of [
    [0, 2055, 1063.81, 11, "SQFT"], [1, secondProduct ? 5055 : 1784, 11, 0, "EACH"]
  ]) {
    const name = index ? (secondProduct ? "TEST-SECOND-PRODUCT" : "PALLET") : "MBBS-Special Order";
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


import crypto from "node:crypto";
import { loadDispatchOrdersForResponse } from "../../../src/server.js";
import { createDispatchPlan, saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { applyDispatchV2Command, syncDispatchPlanOrderAssignments, syncDispatchPlanLoadProjection } from "../../../src/dispatch-planner-v2-repository.js";
import { digestDispatchPlan } from "../../../src/dispatch-planner-performance.js";

test("fully linked PO card cannot be independently planned", () => rollbackTest(async () => {
  const sourcePlan = await seed();
  const cards = await loadDispatchOrdersForResponse({ type: "PO", search: PO_REF, exactOrderRefs: [PO_REF] });
  const card = cards.find(row => row.id === PO_REF);
  assert.ok(card, "PO should be present in exact search");
  assert.equal(card.poRouteProjection.hasResidual, false);
  assert.equal(card.dependencyHidden, true, "fully linked PO must not be independently draggable");
  console.log("AUDIT_PO_CARD", JSON.stringify({
    id: card.id, scmStatus: card.scm?.status, hasResidual: card.poRouteProjection?.hasResidual,
    dispatchPlanned: Boolean(card.dispatchPlanned), dependencyHidden: Boolean(card.dependencyHidden),
    planningRestricted: Boolean(card.dispatchPlanningRestricted), reconciliationBlocked: Boolean(card.reconciliationBlocked)
  }));
  const soCards = await loadDispatchOrdersForResponse({ type: "SO", exactOrderRefs: SO_REFS });
  assert.equal(soCards.length, 2);
  const group = { ...soCards[0], id: GROUP, type: "SO", isGrouped: true, planOwned: true,
    childOrders: SO_REFS, childOrderDetails: soCards, items: soCards.flatMap(order => order.items || []),
    sourceYard: "2967", address: "Test destination", pickupLocations: ["Test Vendor Yard"] };
  const source = { id: String(sourcePlan.id), planDate: "2026-09-25", status: "confirmed", orders: [group],
    trucks: [{ id: "source-truck", plate: "TEST-SOURCE", loads: [{ id: "load-3", name: "Load 3",
      stops: [{ id: "source-group-drop", type: "drop", orderId: GROUP, location: "Test destination" }] }] }], summary: {} };
  await query(`INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary) VALUES ($1,$2::jsonb,$3::jsonb,'{}'::jsonb)`,
    [sourcePlan.id, JSON.stringify(source.orders), JSON.stringify(source.trucks)]);
  await syncDispatchPlanLoadProjection(source);
  await syncDispatchPlanOrderAssignments(source);
  const sourceSchedule = (await listScmSchedule({ exactRef: PO_REF, audience: "scm" })).find(row => row.orderRef === PO_REF);
  assert.equal(sourceSchedule.calculatedStatus, "Direct ship");
  assert.equal(sourceSchedule.dispatchPlanned, true);
  console.log("AUDIT_PO_LINKED_SCHEDULE", sourceSchedule.calculatedStatus);
  const another = await createDispatchPlan({ planDate: "2026-09-26", note: "Isolated direct pickup audit" });
  const saved = await saveDispatchPlanSnapshot(another.id, { planDate: another.planDate, baseRevision: another.revision,
    orders: [card], trucks: [{ id: "audit-truck", plate: "TEST-AUDIT", loads: [{ id: "audit-load", name: "Audit load", stops: [] }] }], summary: {} });
  await assert.rejects(applyDispatchV2Command({ planId: another.id, command: {
    commandId: crypto.randomUUID(), commandType: "assign_order", baseRevision: saved.revision,
    baseDigest: digestDispatchPlan(saved), payload: { orderRef: PO_REF, truckId: "audit-truck", loadId: "audit-load",
      stop: { id: "audit-po-drop", type: "drop", orderId: PO_REF, orderRefs: [PO_REF], location: "2967" } }
  } }), { code: "DISPATCH_LINKED_CARGO_ONLY" });
}));

import { assertSalesDeliveryPlanningAllowed } from "../../../src/dispatch-fulfilled-so-repository.js";
test("fully linked PO aliases are rejected by common server planning guard", () => rollbackTest(async () => {
  await seed();
  for (const ref of [PO_REF, "TEST-POB03921", PO_REF.toLowerCase()]) {
    await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), { code: "DISPATCH_LINKED_CARGO_ONLY" });
  }
}));
test("partial PO and cancelled links retain independent planning", () => rollbackTest(async () => {
  await seed({ salesQty: 1000 });
  await assertSalesDeliveryPlanningAllowed([PO_REF]);
  await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE po_order_id=$1", [PO_ID]);
  const cards = await loadDispatchOrdersForResponse({ type: "PO", exactOrderRefs: [PO_REF], search: PO_REF });
  assert.notEqual(cards.find(row => row.id === PO_REF)?.dependencyHidden, true);
  await assertSalesDeliveryPlanningAllowed([PO_REF]);
}));

for (const residualFirst of [false, true]) {
  test(`partial PO waits for both SO deliveries and remaining PO route; residual first=${residualFirst}`, () => rollbackTest(async () => {
    const plan=await seed({salesQty:1000,secondProduct:true});
    const residual=()=>query(`INSERT INTO driver_job_records (job_id,plan_id,plan_date,driver_login,truck_plate,load_id,
      stop_id,stop_type,order_refs,status,completed_at,job_details) VALUES ('po-residual',$1,'2026-09-25','test','TEST','residual-load',
      'po-residual','dropoff',$2::jsonb,'complete','2026-09-25T20:00:00Z','{"orderTypes":["PO"]}'::jsonb)`,[plan.id,JSON.stringify([PO_REF])]);
    if (residualFirst) await residual();
    assert.equal((await poCompletion()).length,0);
    await complete(plan,{refs:[SO_REFS[0]],jobId:"first-linked-drop"});
    assert.equal((await poCompletion()).length,0);
    await complete(plan,{refs:[SO_REFS[1]],jobId:"second-linked-drop"});
    if (!residualFirst) { assert.equal((await poCompletion()).length,0); await residual(); }
    const [done]=await poCompletion();
    assert.equal(new Date(done.dispatch_completed_at).toISOString(),"2026-09-25T20:00:00.000Z");
    for (const ref of [PO_REF,"TEST-POB03921"]) {
      await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), {code:"DISPATCH_ORDER_DRIVER_COMPLETED"});
    }
  }));
}
