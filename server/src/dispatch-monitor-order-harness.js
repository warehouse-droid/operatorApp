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
  assert.equal(pending[0].driver, "Test Driver");
  assert.equal(pending[0].vehiclePlate, "TEST123");
  assert.equal(pending[0].plannedStart, 500);
  assert.equal(pending[0].plannedEnd, 515);
  assert.deepEqual(pending[0].items.map((item) => [item.itemName, item.quantity, item.unit]), [["Included line", 25.5, "SQFT"]]);

  const pickupComplete = {
    truck_plate: "TEST123",
    load_id: "L1",
    stop_id: "P1",
    order_refs: ["SOA00001"],
    status: "complete",
    started_at: "2026-07-21T11:00:00.000Z",
    completed_at: "2026-07-21T11:30:00.000Z"
  };
  assert.equal(monitorPlannedOrders(plan, [pickupComplete])[0].status, "in_progress");

  const dropComplete = {
    truck_plate: "TEST123",
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
