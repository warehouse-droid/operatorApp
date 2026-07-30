import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canViewRestrictedScmOrders,
  filterRestrictedScmOrders,
  isRestrictedScmOrder
} from "./scm-order-visibility.js";

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

const dispatchResponse = sourceSection(
  serverSource,
  "async function listDispatchOrdersForResponse",
  "async function listScmPurchaseOrdersForResponse",
  "Dispatch order response"
);
assertLateVisibilityGate(dispatchResponse, "Dispatch order response", {
  requiresUnprivilegedGate: true
});

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
    && serverSource.includes("function changedPlacedDispatchScmRefs")
    && serverSource.includes('"DISPATCH_RESTRICTED_SCM_ORDER"'),
  "Dispatch must reject stale attempts to save restricted PO/TO orders."
);
assert(
  (serverSource.match(/assertNoRestrictedScmDispatchOrders\(/g) || []).length >= 6,
  "Dispatch save, confirm, restore, and legacy save paths must enforce the restricted-order guard."
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

console.log("SCM restricted-order role and final-response visibility harness passed.");
