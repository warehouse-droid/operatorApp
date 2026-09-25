import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder, listDeliveryOrders, validateConsolidatedDeliveryOrder } from "../src/delivery-repository.js";
import { getLocalCoOrder } from "../src/dispatch-repository.js";
import { getDispatchPlan } from "../src/dispatch-plan-repository.js";
import { repairDispatchCoCargo } from "../src/dispatch-co-cargo-repair.js";
import { resolveDispatchSalesTarget } from "../src/dispatch-order-target-repository.js";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../src/scm-dependency-command-service.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../src/dispatch-fleet-status.js";
import { pickupUi } from "../test/support/direct-to-same-yard-fixture.mjs";

const [mode, manifestPath] = process.argv.slice(2);
assert.ok(["preview", "apply", "verify"].includes(mode));
assert.ok(manifestPath);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const packedFields = ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];
const isPacked = line => packedFields.some(field => Number(line[field]) > 0);
async function snapshot() {
  const state = {};
  for (const [key, sql] of [
    ["source", "SELECT * FROM sales_orders WHERE tranid='SOA08838'"],
    ["sourceLines", "SELECT * FROM sales_order_lines WHERE sales_order_id=995146 ORDER BY id"],
    ["co", "SELECT * FROM local_co_orders WHERE co_ref='CO-SOA08838'"],
    ["coLines", "SELECT * FROM local_co_order_lines WHERE co_id=(SELECT id FROM local_co_orders WHERE co_ref='CO-SOA08838') ORDER BY id"],
    ["transfer", "SELECT * FROM transfer_orders WHERE tranid='TOB01102'"],
    ["transferLines", "SELECT * FROM transfer_order_lines WHERE transfer_order_id=995267 ORDER BY id"],
    ["dependencies", "SELECT * FROM order_dependencies WHERE sales_order_ref='SOA08838' ORDER BY id"],
    ["allocations", "SELECT l.* FROM order_dependency_lines l JOIN order_dependencies d ON d.id=l.dependency_id WHERE d.sales_order_ref='SOA08838' ORDER BY l.id"],
    ["plans", "SELECT p.id,p.revision,s.orders,s.trucks FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id IN (328,329) ORDER BY p.id"]
  ]) {state[key] = (await query(sql)).rows;}
  return JSON.parse(JSON.stringify(state));
}

function validate(before, after) {
  for (const key of ["sourceLines", "co", "transferLines"]) {assert.deepEqual(after[key], before[key], `${key} changed`);}
  assert.equal(before.coLines.filter(isPacked).length, 5);
  assert.deepEqual(after.coLines.filter(isPacked), before.coLines.filter(isPacked));
  assert.equal(after.coLines.length, 7);
  const material = after.coLines.find(line => Number(line.item_id) === 1356);
  const pallets = after.coLines.find(line => Number(line.item_id) === 1784);
  assert.equal(Number(material.quantity), 0);
  assert.equal(Number(material.layer_qty), 0);
  assert.equal(Number(pallets.quantity), 6);
  assert.equal(after.sourceLines.some(isPacked), false);
  assert.equal(after.sourceLines.some(line => line.confirmed || line.confirmed_at), false);
  assert.equal(after.source[0].operator_status, "open");
  assert.equal(after.source[0].preparing_operator_id, null);
  const allocations = after.allocations.filter(line => line.line_role === "sales_allocation");
  assert.equal(allocations.length, 2);
  assert.equal(Number(allocations.find(line => Number(line.item_id) === 1356).allocated_quantity), 52.25);
  assert.equal(Number(allocations.find(line => Number(line.item_id) === 1784).allocated_quantity), 1);
  assert.equal(Number(after.transferLines.find(line => line.line_stage === "outbound" && Number(line.item_id) === 1784).quantity), 1);
}

async function verifyViews() {
  const detail = await getDeliveryOrder("CO-SOA08838");
  const lists = {};
  for (const status of ["packed", "active"]) {
    lists[status] = (await listDeliveryOrders({ locationId: 26, status, orderType: "sales_order" }))
      .find(row => row.tranid === "CO-SOA08838");
    assert.ok(lists[status], `CO missing from ${status}`);
    assert.equal(lists[status].underpack_count, 1);
  }
  assert.equal(detail.lines.length, 6);
  assert.equal(detail.lines.filter(isPacked).length, 5);
  assert.equal(detail.lines.some(line => Number(line.item_id) === 1356), false);
  assert.equal(Number(detail.lines.find(line => Number(line.item_id) === 1784).quantity), 6);
  assert.equal(detail.status, "packed");
  assert.equal(validateConsolidatedDeliveryOrder(detail).ok, true);
  const coPlan = await getDispatchPlan(328);
  const co = coPlan.orders.find(order => order.id === "CO-SOA08838");
  assert.equal(co.items.length, 6);
  assert.equal(co.items.some(item => Number(item.itemId) === 1356), false);
  assert.equal(Number(co.items.find(item => Number(item.itemId) === 1784).quantity), 6);
  const soPlan = await getDispatchPlan(329);
  const so = soPlan.orders.find(order => order.id === "SOA08838");
  const ui = pickupUi();
  const pickup = ui.tooltipItemsForOrder(so, { pickupLocation: "3445" });
  const drop = ui.tooltipItemsForOrder(so, { stop: { type: "drop" } });
  assert.equal(Number(drop.find(item => Number(item.itemId) === 1356).quantity), 52.25);
  assert.equal(Number(drop.find(item => Number(item.itemId) === 1784).quantity), 7);
  assert.equal(pickup.filter(item => Number(item.itemId) === 1784).reduce((sum, item) => sum + Number(item.quantity), 0), 7);
  const html = ui.tooltipItemRowsForOrder(so, { pickupLocation: "3445", includeOrderHeader: true });
  assert.equal((html.match(/<b>TOB01102<\/b>/gu) || []).length, 1);
  return { packedVisible: true, activeVisible: true, packedLines: 5, remainingPallets: 6,
    coCargoLines: 6, trevistaDirectTo: 52.25, palletsDirectTo: 1,
    customerPallets: 7, toPickupHeaderCount: 1, loadValidation: "passed",
    planRevisions: [Number(coPlan.revision), Number(soPlan.revision)] };
}

async function buildCommand() {
  const plan = await getDispatchPlan(329);
  const target = await resolveDispatchSalesTarget({ dispatchTargetRef: "SOA08838", planDate: plan.planDate });
  const line = target.lines.find(row => Number(row.salesLineId) === 453790);
  assert.ok(line);
  const command = { requestId: crypto.randomUUID(), action: "link_to", targetRef: "SOA08838",
    targetSignature: target.signature, planId: plan.id, planDate: plan.planDate,
    expectedPlanRevision: Number(plan.revision), expectedPlanDigest: plan.digest,
    payload: { transferOrderRef: "TOB01102", mode: "direct_to_customer",
      allocations: [{ targetLineKey: line.targetLineKey, quantities: { salesQty: 1 } }] } };
  command.payloadHash = scmDependencyPayloadHash(command);
  return command;
}

async function refreshCoPlan() {
  const co = await getLocalCoOrder("CO-SOA08838");
  const plan = await getDispatchPlan(328);
  const owners = plan.trucks.flatMap(truck => truck.loads.filter(load => load.stops.some(stop =>
    stop.orderId === co.co_ref || (stop.orderRefs || []).includes(co.co_ref))));
  assert.equal(owners.length, 1);
  const target = { planId: 328, planDate: plan.planDate, coRef: co.co_ref,
    sourceOrderRef: "SOA08838", fromYard: "150", toYard: "3445", lines: co.lines,
    loadId: owners[0].id, driverLogin: owners[0].driverLogin };
  const preview = await repairDispatchCoCargo({ target });
  const repaired = await repairDispatchCoCargo({ target, apply: true,
    expectedRevision: preview.revision, expectedFingerprint: preview.fingerprint });
  assert.equal(repaired.applied, true);
}

try {
  if (mode === "verify") {
    const saved = JSON.parse(await readFile(manifestPath, "utf8"));
    validate(saved.before, await snapshot());
    console.log(JSON.stringify({ verified: true, ...await verifyViews() }));
  } else {
    const saved = mode === "apply" ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
    let evidence;
    await withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
      const before = await snapshot();
      assert.equal(before.co[0].status, "pending_load");
      assert.equal(before.co[0].loaded_at, null);
      assert.equal(before.co[0].received_at, null);
      assert.equal(before.co[0].preparing_operator_id, null);
      assert.equal(before.co[0].preparing_started_at, null);
      if (saved) {assert.equal(hash(before), saved.beforeHash, "Order state changed after preview");}
      const command = saved?.command || await buildCommand();
      const result = await executeScmDependencyCommand(command, { surface: "scm", sessionId: "codex:co-direct-to-repair" });
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(result.effectiveAction, "extend_to");
      await refreshCoPlan();
      const after = await snapshot();
      validate(before, after);
      evidence = { beforeHash: hash(before), before, command, after, views: await verifyViews() };
    }, { rollback: mode === "preview" });
    if (mode === "preview") {
      assert.equal(hash(await snapshot()), evidence.beforeHash, "Preview must roll back completely");
      await writeFile(manifestPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    }
    console.log(JSON.stringify({ mode, ...evidence.views }));
  }
} finally {await closeDb();}
