import assert from "node:assert/strict";
import { closeDb } from "./db.js";
import { dispatchStatisticStopFromRow } from "./dispatch-statistics-repository.js";

const planPayload = {
  plan_id: "991",
  plan_date: "2026-07-22",
  summary: { ownYardCodes: ["CUSTOM-YARD"] },
  orders: [{
    id: "PO-STATS-V2",
    type: "PO",
    destinationYard: "CUSTOM-YARD",
    pickupLocations: ["CUSTOM-YARD"],
    items: [
      { lineRowId: "101", pallets: 2, layers: 0 },
      { lineRowId: "202", pallets: 5, layers: 0 }
    ]
  }],
  trucks: [{
    id: "PARENT-A",
    plate: "PARENT-A",
    ownYardFixedMinutes: 41,
    loads: [{
      id: "LOAD-SWITCHED",
      name: "Switched load",
      driverLogin: "driver-v2",
      truckId: "ASSIGNED-B",
      truckPlate: "ASSIGNED-B",
      ownYardFixedMinutes: 57,
      vendorFixedMinutes: 31,
      deliveryFixedMinutes: 33,
      minutesPerPallet: 2,
      truckSwitchMinutes: 12,
      stops: [
        { id: "PICK-CUSTOM", type: "pick", orderId: "PO-STATS-V2", location: "CUSTOM-YARD" },
        { id: "DROP-LINE-101", type: "drop", orderId: "PO-STATS-V2", dropLocation: "Customer Site", lineRowIds: ["101"] }
      ]
    }]
  }, {
    id: "ASSIGNED-B",
    plate: "ASSIGNED-B",
    ownYardFixedMinutes: 99,
    loads: []
  }]
};

function row(overrides = {}) {
  return {
    ...planPayload,
    job_id: "JOB-V2",
    driver_login: "driver-v2",
    truck_id: "ASSIGNED-B",
    truck_plate: "ASSIGNED-B",
    load_id: "LOAD-SWITCHED",
    load_name: "Switched load",
    stop_id: "PICK-CUSTOM",
    stop_type: "pickup",
    order_refs: ["PO-STATS-V2"],
    photo_data_urls: [],
    status: "complete",
    started_at: "2026-07-22T12:00:00.000Z",
    completed_at: "2026-07-22T12:57:00.000Z",
    rest_seconds: 0,
    ...overrides
  };
}

try {
  const pickup = dispatchStatisticStopFromRow(row());
  assert.equal(pickup.stopClass, "own_yard");
  assert.equal(pickup.truckPlate, "ASSIGNED-B");
  assert.equal(pickup.pallets, 7);
  assert.equal(pickup.plannedMinutes, 57, "The load's driver timing must win over both parent and assigned-truck defaults.");

  const drop = dispatchStatisticStopFromRow(row({
    stop_id: "DROP-LINE-101",
    stop_type: "dropoff",
    completed_at: "2026-07-22T12:37:00.000Z"
  }));
  assert.equal(drop.stopClass, "delivery");
  assert.equal(drop.pallets, 2, "A PO multi-drop statistic must include only that stop's order lines.");
  assert.equal(drop.plannedMinutes, 37);

  const truckSwitch = dispatchStatisticStopFromRow(row({
    stop_id: "truck-switch-LOAD-SWITCHED",
    stop_type: "truck_switch",
    order_refs: [],
    completed_at: "2026-07-22T12:12:00.000Z"
  }));
  assert.equal(truckSwitch.stopClass, "truck_switch");
  assert.equal(truckSwitch.plannedMinutes, 12);

  console.log(JSON.stringify({ ok: true, tests: 9 }));
} finally {
  await closeDb();
}
