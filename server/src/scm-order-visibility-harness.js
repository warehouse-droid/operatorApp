import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canViewRestrictedScmOrders,
  filterRestrictedScmOrders,
  isRestrictedScmOrder
} from "./scm-order-visibility.js";
import { changedPlacedDispatchScmAssignmentRefs } from "./dispatch-scm-placement.js";

const serverSource = await readFile(new URL("./server.js", import.meta.url), "utf8");

function sourceSection(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `${label} start marker is missing: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end > start, `${label} end marker is missing: ${endMarker}`);
  return source.slice(start, end);
}

function assertLateVisibilityGate(section, label, {
  requiresRoleGate = false,
  requiresUnprivilegedGate = false
} = {}) {
  const enrichmentAt = section.indexOf("enrichScmScheduleWithReconciliation");
  const filterAt = section.lastIndexOf("filterRestrictedScmOrders");
  assert(enrichmentAt >= 0, `${label} must perform reconciliation enrichment.`);
  assert(
    filterAt > enrichmentAt,
    `${label} must apply its restricted-order filter to the final response after reconciliation enrichment.`
  );
  if (requiresRoleGate) {
    assert(
      section.includes("canViewRestrictedScmOrders(req.operator)"),
      `${label} must derive restricted-order access from the authenticated operator.`
    );
  }
  if (requiresUnprivilegedGate) {
    assert.match(
      section,
      /filterRestrictedScmOrders\([\s\S]*?includeRestricted:\s*false/,
      `${label} must not expose a query-controlled restricted-order override.`
    );
  }
}

const privilegedOperators = [
  { role: "admin" },
  { role: "ADMIN" },
  { role: "scm" },
  { role: "scm_staff" },
  { role: "SCM Staff" },
  { role: "scm-staff" },
  { role: "dispatcher", roles: ["dispatcher", "SCM"] },
  { role: "sales", roles: ["sales", "admin"] },
  { role: "yard_manager", roles: ["yard_manager", "scm_staff"] }
];
for (const operator of privilegedOperators) {
  assert.equal(
    canViewRestrictedScmOrders(operator),
    true,
    `SCM/Admin authority should reveal restricted schedule rows: ${JSON.stringify(operator)}`
  );
}

const unprivilegedOperators = [
  null,
  {},
  { role: "dispatcher" },
  { role: "sales" },
  { role: "yard_manager" },
  { role: "Yard Manager" },
  { role: "dispatcher", roles: ["dispatcher", "sales", "yard-manager"] }
];
for (const operator of unprivilegedOperators) {
  assert.equal(
    canViewRestrictedScmOrders(operator),
    false,
    `Non-SCM roles must not reveal restricted schedule rows: ${JSON.stringify(operator)}`
  );
}

const restrictedRows = [
  { id: "BLANKET", isBlanket: true, status: "Queued" },
  { id: "HOLD", status: "Hold" },
  { id: "HOLD-NORMALIZED", status: "  hOlD  " },
  { id: "COMPLETE", status: "Complete" },
  { id: "COMPLETED", status: " completed " },
  { id: "CANCELLED", status: "Cancelled" },
  { id: "CANCELED", status: " cAnCeLeD " },
  { id: "DISPATCH-COMPLETE", scm: { status: "Complete" } },
  { id: "DISPATCH-CANCELLED", scm: { status: "Canceled" } },
  {
    id: "REVIEWED-COMPLETION",
    status: "Reconcile Review",
    reconciliationApplicationStatus: "Completed"
  }
];
for (const row of restrictedRows) {
  assert.equal(
    isRestrictedScmOrder(row),
    true,
    `${row.id} should be recognized as a restricted order.`
  );
}

const normalRows = [
  { id: "QUEUED", status: "Queued" },
  { id: "PLANNED", status: "Planned" },
  { id: "INITIAL-HOLD-QUEUED", status: "Queued", initialScmStatus: "Hold" },
  { id: "INITIAL-HOLD-PLANNED", scm: { status: "Planned" }, raw: { initial_scm_status: "Hold" } },
  {
    id: "INITIAL-HOLD-RECONCILED",
    status: "Hold",
    reconciliationApplicationStatus: "Queued",
    raw: { initial_scm_status: "Hold" }
  },
  { id: "PARTIAL", status: "Partially Done" },
  { id: "TRANSIT", status: "In Transit" },
  { id: "REVIEW", status: "Reconcile Review" },
  { id: "URGENT", status: "Urgent" },
  { id: "EMPTY", status: "" }
];
for (const row of normalRows) {
  assert.equal(
    isRestrictedScmOrder(row),
    false,
    `${row.id} must remain visible to non-SCM roles.`
  );
}

const mixedRows = [...normalRows, ...restrictedRows];
assert.deepEqual(
  filterRestrictedScmOrders(mixedRows, { includeRestricted: false }).map((row) => row.id),
  normalRows.map((row) => row.id),
  "Sales, Dispatch, and Yard Manager feeds must retain only normal rows."
);
assert.deepEqual(
  filterRestrictedScmOrders(mixedRows, { includeRestricted: true }).map((row) => row.id),
  mixedRows.map((row) => row.id),
  "SCM and Admin schedule feeds must retain restricted rows."
);
assert.equal(mixedRows.length, normalRows.length + restrictedRows.length,
  "Filtering must not mutate the source row collection.");

const historicPlan = {
  orders: [
    { id: "SOB114411", type: "SO" },
    { id: "TOB00603", type: "TO", weight: 28 },
    { id: "POB03530", type: "PO", weight: 2804.34 }
  ],
  trucks: [
    {
      id: "T2",
      loads: [{
        id: "T2-LOAD",
        stops: [
          { id: "so-pick", orderId: "SOB114411", type: "pick", location: "3445" },
          { id: "so-drop", orderId: "SOB114411", type: "drop", location: "Customer" }
        ]
      }]
    },
    {
      id: "T5",
      loads: [{
        id: "T5-LOAD",
        stops: [
          { id: "po-pick-old", orderId: "POB03530", type: "pick", location: "Vendor" },
          { id: "to-pick-redundant", orderId: "TOB00603", type: "pick", location: "Vendor" },
          { id: "to-drop", orderId: "TOB00603", type: "drop", location: "12441" },
          { id: "po-drop", orderId: "POB03530", type: "drop", location: "12441" }
        ]
      }]
    }
  ]
};
const unrelatedSalesRemoval = structuredClone(historicPlan);
unrelatedSalesRemoval.orders = unrelatedSalesRemoval.orders
  .filter((order) => order.id !== "SOB114411")
  .map((order) => ({ ...order, weight: Number(order.weight || 0), localDispatchStatus: "planned" }));
unrelatedSalesRemoval.trucks[0].loads[0].stops = [];
unrelatedSalesRemoval.trucks[1].loads[0].stops = unrelatedSalesRemoval.trucks[1].loads[0].stops
  .filter((stop) => stop.id !== "to-pick-redundant")
  .map((stop) => stop.id === "po-pick-old" ? { ...stop, id: "po-pick-regenerated" } : stop);
assert.deepEqual(
  changedPlacedDispatchScmAssignmentRefs(historicPlan, unrelatedSalesRemoval),
  [],
  "Removing an unrelated SO must not revalidate unchanged completed PO/TO load assignments."
);

const movedRestrictedOrder = structuredClone(historicPlan);
movedRestrictedOrder.trucks[1].loads.push({
  id: "T5-LOAD-2",
  stops: [movedRestrictedOrder.trucks[1].loads[0].stops.shift()]
});
const movedToDrop = movedRestrictedOrder.trucks[1].loads[0].stops
  .find((stop) => stop.orderId === "TOB00603" && stop.type === "drop");
movedRestrictedOrder.trucks[1].loads[0].stops = movedRestrictedOrder.trucks[1].loads[0].stops
  .filter((stop) => stop !== movedToDrop);
movedRestrictedOrder.trucks[1].loads[1].stops.push(movedToDrop);
assert.deepEqual(
  changedPlacedDispatchScmAssignmentRefs(historicPlan, movedRestrictedOrder),
  ["TOB00603"],
  "Moving a restricted PO/TO to another load must still be rejected."
);

const newlyPlacedOrder = structuredClone(historicPlan);
newlyPlacedOrder.orders.push({ id: "TOB00999", type: "TO" });
newlyPlacedOrder.trucks[1].loads[0].stops.push({
  id: "new-to-drop",
  orderId: "TOB00999",
  type: "drop",
  location: "12441"
});
assert.deepEqual(
  changedPlacedDispatchScmAssignmentRefs(historicPlan, newlyPlacedOrder),
  ["TOB00999"],
  "Newly placed restricted PO/TO orders must remain subject to the guard."
);

const removedRestrictedOrder = structuredClone(historicPlan);
removedRestrictedOrder.trucks[1].loads[0].stops = removedRestrictedOrder.trucks[1].loads[0].stops
  .filter((stop) => stop.orderId !== "TOB00603");
assert.deepEqual(
  changedPlacedDispatchScmAssignmentRefs(historicPlan, removedRestrictedOrder),
  [],
  "Removing a restricted PO/TO from Dispatch must remain allowed."
);

const dispatchResponse = sourceSection(
  serverSource,
  "async function listDispatchOrdersForResponse",
  "async function listScmPurchaseOrdersForResponse",
  "Dispatch order response"
);
assertLateVisibilityGate(dispatchResponse, "Dispatch order response", {
  requiresUnprivilegedGate: true
});

const purchaseOrderResponse = sourceSection(
  serverSource,
  "async function listScmPurchaseOrdersForResponse",
  "function sendDispatchDependencyConflictResponse",
  "Purchase order split response"
);
assert.match(purchaseOrderResponse, /scheduleId:\s*order\.scm\?\.scheduleId/,
  "PO split reconciliation must receive the persisted schedule ID.");
assert.match(purchaseOrderResponse, /updatedAt:\s*order\.scm\?\.updatedAt/,
  "PO split reconciliation must receive the persisted schedule update time.");

const salesScheduleResponse = sourceSection(
  serverSource,
  'app.get("/api/sales/schedule"',
  'app.get("/api/sales/schedule-preferences"',
  "Sales schedule response"
);
assertLateVisibilityGate(salesScheduleResponse, "Sales schedule response", {
  requiresUnprivilegedGate: true
});

const staffScheduleResponse = sourceSection(
  serverSource,
  'app.get("/api/scm/schedule"',
  'app.get("/api/scm/schedule-formatting"',
  "Staff schedule response"
);
assertLateVisibilityGate(staffScheduleResponse, "Staff schedule response", {
  requiresRoleGate: true
});

assert(
  !dispatchResponse.includes("req.query.includeRestricted")
    && !dispatchResponse.includes("req.query.includeHiddenScm"),
  "Dispatch restricted-order visibility must not be enabled by a request query parameter."
);
assert(
  !staffScheduleResponse.includes("req.query.includeRestricted"),
  "Schedule restricted-order access must come from authenticated roles, not a query parameter."
);

assert(
  serverSource.includes("async function assertNoRestrictedScmDispatchOrders")
    && serverSource.includes("changedPlacedDispatchScmAssignmentRefs")
    && serverSource.includes('"DISPATCH_RESTRICTED_SCM_ORDER"'),
  "Dispatch must reject stale attempts to save restricted PO/TO orders."
);
assert(
  (serverSource.match(/assertNoRestrictedScmDispatchOrders\(/g) || []).length >= 6,
  "Dispatch save, confirm, restore, and legacy save paths must enforce the restricted-order guard."
);
assert(
  (serverSource.match(/changedPlacedDispatchScmAssignmentRefs/g) || []).length >= 5,
  "Dispatch save, submitted-confirm, restore, and legacy save paths must scope the guard to real PO/TO assignment changes."
);
const restrictedRefSource = sourceSection(
  serverSource,
  "async function listRestrictedScmDispatchOrderRefs",
  "function dispatchOrderLogicalRefs",
  "Restricted SCM reference derivation"
);
assert.match(
  restrictedRefSource,
  /initial_scm_status[\s\S]*?AND NOT EXISTS \([\s\S]*?FROM scm_transport_schedule current_schedule/,
  "A current PO schedule status must override the intake-time Hold status."
);
assert.match(
  restrictedRefSource,
  /AND NOT EXISTS \([\s\S]*?FROM scm_reconciliation_order_state current_state/,
  "A current PO reconciliation status must override the intake-time Hold status."
);
assert.match(
  restrictedRefSource,
  /manual_schedule\.updated_at > state\.reconciled_at/,
  "A newer manual SCM schedule status must override stale reconciliation restrictions."
);
assert.match(
  restrictedRefSource,
  /applicationStatus'[\s\S]*?IN \('complete', 'completed'\)[\s\S]*?OR NOT EXISTS/,
  "Completed reconciliation targets must remain terminal despite a newer manual SCM status."
);

console.log("SCM restricted-order role and final-response visibility harness passed.");
