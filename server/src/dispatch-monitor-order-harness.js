import assert from "node:assert/strict";

const { monitorPlannedOrders } = await import("./server.js");
const { closeDb } = await import("./db.js");

const plan = {
  id: "monitor-test",
  planDate: "2026-07-21",
  orders: [{
    id: "SOA00001",
    type: "SO",
    sourceYard: "12441",
    destinationAddress: "1 Customer Road",
    items: [
      { lineRowId: 1, itemName: "Excluded split line", quantity: 10, unit: "SQFT" },
      { lineRowId: 2, itemName: "Included line", quantity: 25.5, unit: "SQFT" }
    ]
  }],
  trucks: [{
    id: "T1",
    plate: "TEST123",
    driver: "Test Driver",
    base: "12441",
    loads: [{
      id: "L1",
      name: "Load 1",
      driverLogin: "load-driver",
      driverName: "Load Driver",
      truckId: "T2",
      truckPlate: "SWITCH456",
      parkingSpot: "P-7",
      stops: [
        { id: "P1", type: "pick", orderId: "SOA00001", location: "12441", timing: { arrival: 420, depart: 450 } },
        { id: "D1", type: "drop", orderId: "SOA00001", location: "Customer", lineRowIds: [2], timing: { arrival: 500, depart: 515 } }
      ]
    }]
  }]
};

try {
  const pending = monitorPlannedOrders(plan, []);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].fromLocation, "12441");
  assert.equal(pending[0].destination, "1 Customer Road");
  assert.equal(pending[0].driver, "Load Driver");
  assert.equal(pending[0].driverLogin, "load-driver");
  assert.equal(pending[0].vehiclePlate, "SWITCH456");
  assert.equal(pending[0].truckPlate, "SWITCH456");
  assert.equal(pending[0].parkingSpot, "P-7");
  assert.equal(pending[0].plannedStart, 500);
  assert.equal(pending[0].plannedEnd, 515);
  assert.deepEqual(pending[0].items.map((item) => [item.itemName, item.quantity, item.unit]), [["Included line", 25.5, "SQFT"]]);

  const staleLinePlan = structuredClone(plan);
  staleLinePlan.trucks[0].loads[0].stops[1].lineRowIds = [999999];
  assert.deepEqual(monitorPlannedOrders(staleLinePlan, [])[0].items, [], "A stale multi-drop line ID must not expose every order line.");

  const multiDropPlan = {
    id: "monitor-po-multi-drop",
    planDate: "2026-07-22",
    orders: [{
      id: "POB00001",
      type: "PO",
      sourceYard: "Vendor Yard",
      destinationYard: "Order destination fallback",
      destinationAddress: "Order address fallback",
      items: [
        { lineRowId: 11, itemName: "First-stop tile", quantity: 12, unit: "CTN" },
        { lineRowId: 22, itemName: "Second-stop stone", quantity: 8, unit: "PCS" }
      ]
    }],
    trucks: [{
      id: "PO-TRUCK",
      plate: "PO123",
      driver: "PO Driver",
      base: "12441",
      loads: [{
        id: "PO-LOAD",
        name: "PO multi-drop load",
        stops: [
          { id: "PO-PICK", type: "pick", orderId: "POB00001", location: "Vendor Yard" },
          {
            id: "PO-DROP-1",
            type: "drop",
            orderId: "POB00001",
            dropLocation: "2967",
            dropAddress: "First drop address",
            destinationYard: "First destination yard",
            location: "First generic location",
            lineRowIds: [11]
          },
          {
            id: "PO-DROP-2",
            type: "drop",
            orderId: "POB00001",
            dropAddress: "Second drop address",
            destinationYard: "Second destination yard",
            location: "Second generic location",
            lineRowIds: [22]
          }
        ]
      }]
    }]
  };
  const multiDropRows = monitorPlannedOrders(multiDropPlan, []);
  assert.equal(multiDropRows.length, 2);
  assert.equal(multiDropRows[0].destination, "2967");
  assert.deepEqual(multiDropRows[0].items.map((item) => [item.itemName, item.quantity, item.unit]), [["First-stop tile", 12, "CTN"]]);
  assert.equal(multiDropRows[1].destination, "Second drop address");
  assert.deepEqual(multiDropRows[1].items.map((item) => [item.itemName, item.quantity, item.unit]), [["Second-stop stone", 8, "PCS"]]);

  const destinationFallbackPlan = structuredClone(multiDropPlan);
  delete destinationFallbackPlan.trucks[0].loads[0].stops[2].dropAddress;
  assert.equal(monitorPlannedOrders(destinationFallbackPlan, [])[1].destination, "Second destination yard");
  delete destinationFallbackPlan.trucks[0].loads[0].stops[2].destinationYard;
  assert.equal(monitorPlannedOrders(destinationFallbackPlan, [])[1].destination, "Order destination fallback");
  delete destinationFallbackPlan.orders[0].destinationYard;
  delete destinationFallbackPlan.orders[0].destinationAddress;
  assert.equal(monitorPlannedOrders(destinationFallbackPlan, [])[1].destination, "Second generic location");

  const pickupComplete = {
    truck_plate: "SWITCH456",
    load_id: "L1",
    stop_id: "P1",
    order_refs: ["SOA00001"],
    status: "complete",
    started_at: "2026-07-21T11:00:00.000Z",
    completed_at: "2026-07-21T11:30:00.000Z"
  };
  assert.equal(monitorPlannedOrders(plan, [pickupComplete])[0].status, "in_progress");

  const dropComplete = {
    truck_plate: "SWITCH456",
    load_id: "L1",
    stop_id: "D1",
    order_refs: ["SOA00001"],
    status: "complete",
    started_at: "2026-07-21T12:20:00.000Z",
    completed_at: "2026-07-21T12:35:00.000Z"
  };
  const completed = monitorPlannedOrders(plan, [pickupComplete, dropComplete])[0];
  assert.equal(completed.status, "complete");
  assert.equal(completed.actualStart, dropComplete.started_at);
  assert.equal(completed.actualEnd, dropComplete.completed_at);

  console.log("Dispatch monitor planned-order checks passed.");
} finally {
  await closeDb();
}
