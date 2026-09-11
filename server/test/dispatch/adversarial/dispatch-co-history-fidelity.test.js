import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { sanitizeDispatchReplayPlan, buildDispatchPickupRevisitReplay, buildDispatchHistoricalReplayArtifact } from "../../../src/dispatch-planner-replay.js";
import { materializeDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";

function plan(order, pickup) {
  return { id: "PLAN", planDate: "2026-09-04", orders: [order], trucks: [{ id: "T", driver: "test", loads: [{ id: "L", pickupVisitSchemaVersion: 1, stops: [
    { id: "P", type: "pick", orderId: order.id, orderRefs: [order.id], location: pickup },
    { id: "D", type: "drop", orderId: order.id }
  ] }] }] };
}

test("anonymization preserves vendor allocation cargo and does not invent a source-yard pickup", () => {
  const source = plan({ id: "GOA-TEST", type: "SO", sourceYard: "2967", pickupLocations: ["2967", "Vendor"], address: "Private customer address",
    items: [{ itemId: 2055, sku: "MBBS-Special Order", quantity: 100, pallets: 6, poAllocatedPallets: 6, poAllocatedSalesQty: 100 }],
    poPickupManifest: [{ poOrderRef: "PO-TEST", location: "Vendor", items: [{ itemId: 2055, quantity: 100, pallets: 6 }] }]
  }, "Vendor");
  assert.deepEqual(materializeDispatchPickupVisits(source).conflicts, []);
  const sanitized = sanitizeDispatchReplayPlan(source);
  assert.deepEqual(materializeDispatchPickupVisits(sanitized).conflicts, []);
  assert.equal(sanitized.orders[0].items[0].poAllocatedPallets, 6);
  assert.equal(sanitized.orders[0].poPickupManifest[0].items.length, 1);
  assert.doesNotMatch(JSON.stringify(sanitized), /Private customer|MBBS-Special Order/);
});

test("anonymization keeps fee-only deliveries empty and retains hierarchical own-yard identity", () => {
  const source = plan({ id: "FEE", type: "SO", sourceYard: "2967", pickupLocations: ["2967"], items: [{ sku: "Delivery Charge", quantity: 1 }] }, "2967");
  source.trucks[0].loads[0].stops.shift();
  assert.deepEqual(materializeDispatchPickupVisits(sanitizeDispatchReplayPlan(source)).conflicts, []);
  const physical = plan({ id: "PHYSICAL", type: "SO", sourceYard: "2967 : Yard A", pickupLocations: ["2967 : Yard A"], items: [{ quantity: 1, pallets: 1 }] }, "2967");
  assert.deepEqual(materializeDispatchPickupVisits(sanitizeDispatchReplayPlan(physical)).conflicts, []);
});

test("SCM schedule audit evidence is captured in the SCM stream", () => {
  const source = fs.readFileSync(new URL("../../../tools/dispatch-planner-history-replay.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  for (const row of audits.rows)");
  const end = source.indexOf("  for (const row of scmChanges.rows)", start);
  assert.ok(start > 0 && end > start);
  const stream = Function("audits", "eventId", "iso", "pseudonym", `const events=[];${source.slice(start,end)};return events[0].stream;`)(
    { rows: [{ id: 1, action: "scm.schedule.updated", source: "scm", has_details: true }] }, () => "event", () => "2026-09-04", () => "source"
  );
  assert.equal(stream, "scm");
});

test("stream evidence counts actual SCM audit rows but never a coverage-gap placeholder", () => {
  const capture = { schemaVersion: 1, window: { from: "2026-09-04T00:00:00Z", to: "2026-09-05T00:00:00Z" },
    sourceCounts: { dispatch_audit_log: 1, scm_netsuite_po_history_changes: 0 }, events: [
      { id: "SCM-AUDIT", stream: "scm", action: "scm.schedule.updated", serverAt: "2026-09-04T01:00:00Z", payload: { present: true } },
      { id: "SCM-GAP", stream: "scm", action: "coverage_gap:scm_netsuite_po_history_changes", serverAt: "2026-09-04T00:00:00Z" }
    ] };
  const result = buildDispatchHistoricalReplayArtifact({ capture });
  assert.equal(result.assertions.hasScmEvidence, true);
  assert.equal(result.captureValidation.sourceStreamCounts.scm, 1);
  assert.equal(result.assertions.everySourceRowAccountedFor, true);
  const gapsOnly = buildDispatchHistoricalReplayArtifact({ capture: { ...capture, sourceCounts: { scm_netsuite_po_history_changes: 0 }, events: [capture.events[1]] } });
  assert.equal(gapsOnly.assertions.hasScmEvidence, false);
});

test("vendor late-pickup replay injects physically allocated vendor cargo", () => {
  const source = plan({ id: "PO-TEST", type: "PO", sourceYard: "Vendor", pickupLocations: ["Vendor"], address: "Delivery", items: [{ quantity: 1, pallets: 1 }] }, "Vendor");
  const result = buildDispatchPickupRevisitReplay({ capture: { events: [{ id: "E", stream: "dispatch", planState: sanitizeDispatchReplayPlan(source) }], driverActivity: [] } });
  assert.ok(result.fakeOrdersInjected > 0);
  assert.equal(result.assertions.everyInjectionHasPickup, true);
  assert.equal(result.driverScopeFailureCount, 0);
});
