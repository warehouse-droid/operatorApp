import assert from "node:assert/strict";
import { closeDb } from "./db.js";
import {
  dispatchStatisticStopFromRow,
  dispatchStatisticStopsFromRows
} from "./dispatch-statistics-repository.js";

const planPayload = {
  plan_id: "991",
  plan_date: "2026-07-22",
  summary: { ownYardCodes: ["CUSTOM-YARD", "3445"] },
  orders: [{
    id: "PO-STATS-V2",
    type: "PO",
    destinationYard: "CUSTOM-YARD",
    pickupLocations: ["CUSTOM-YARD"],
    items: [
      { lineRowId: "101", pallets: 2, layers: 0 },
      { lineRowId: "202", pallets: 5, layers: 0 }
    ]
  }, {
    id: "20260729_Ayr_pallet",
    type: "PO",
    sourceTable: "scm_vrma_orders",
    parseSource: "scm-vrma",
    destinationYard: "Ayr Vendor Yard",
    pickupLocations: ["3445"],
    pallets: 10,
    items: []
  }, {
    id: "CUSTOM-STATS-V2",
    type: "CUSTOM",
    sourceTable: "dispatch_custom_orders",
    customOrder: true,
    destinationYard: "Customer Site",
    pickupLocations: ["3445"],
    stopMinutes: 64,
    raw: { stop_minutes: 64 },
    pallets: 0,
    items: []
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
        { id: "DROP-LINE-101", type: "drop", orderId: "PO-STATS-V2", dropLocation: "Customer Site", lineRowIds: ["101"] },
        { id: "DROP-VRMA", type: "drop", orderId: "20260729_Ayr_pallet", dropLocation: "Ayr Vendor Yard" },
        { id: "DROP-CUSTOM", type: "drop", orderId: "CUSTOM-STATS-V2", dropLocation: "Customer Site" }
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
  const childLocationPlan = structuredClone(planPayload);
  childLocationPlan.orders[0].pickupLocations = ["CUSTOM-YARD : Special inventory"];
  childLocationPlan.trucks[0].loads[0].stops[0].location = "CUSTOM-YARD : Special inventory";
  const childLocationPickup = dispatchStatisticStopFromRow(row(childLocationPlan));
  assert.equal(childLocationPickup.stopClass, "own_yard", "A child location must inherit its parent yard timing class.");
  assert.equal(childLocationPickup.pallets, 7, "A child pickup must retain its parent-yard order footprint.");
  const currentDriverProfilePickup = dispatchStatisticStopFromRow(row(), {
    driverProfile: {
      login: "driver-v2",
      ownYardFixedMinutes: 30,
      vendorFixedMinutes: 28,
      deliveryFixedMinutes: 32,
      minutesPerPallet: 1
    }
  });
  assert.equal(currentDriverProfilePickup.plannedMinutes, 30, "The assigned driver's current configured rule must win over a stale plan snapshot.");

  const drop = dispatchStatisticStopFromRow(row({
    stop_id: "DROP-LINE-101",
    stop_type: "dropoff",
    completed_at: "2026-07-22T12:37:00.000Z"
  }));
  assert.equal(drop.stopClass, "delivery");
  assert.equal(drop.pallets, 2, "A PO multi-drop statistic must include only that stop's order lines.");
  assert.equal(drop.plannedMinutes, 37);

  const vrmaDrop = dispatchStatisticStopFromRow(row({
    stop_id: "DROP-VRMA",
    stop_type: "dropoff",
    order_refs: ["20260729_Ayr_pallet"],
    completed_at: "2026-07-22T12:31:00.000Z"
  }));
  assert.equal(vrmaDrop.stopClass, "vendor_yard");
  assert.equal(vrmaDrop.pallets, 10);
  assert.equal(vrmaDrop.plannedMinutes, 31, "A local VRMA drop must use vendor fixed time without delivery pallet minutes.");

  const customDrop = dispatchStatisticStopFromRow(row({
    stop_id: "DROP-CUSTOM",
    stop_type: "dropoff",
    order_refs: ["CUSTOM-STATS-V2"],
    completed_at: "2026-07-22T13:04:00.000Z"
  }));
  assert.equal(customDrop.stopClass, "delivery");
  assert.equal(customDrop.plannedMinutes, 64, "A Custom Order drop must use its dispatcher-entered stop time.");

  const rawCustomOrders = planPayload.orders.map((order) => order.id === "CUSTOM-STATS-V2"
    ? { ...order, stopMinutes: null, raw: { ...order.raw, stop_minutes: 52 } }
    : order);
  const rawCustomDrop = dispatchStatisticStopFromRow(row({
    orders: rawCustomOrders,
    stop_id: "DROP-CUSTOM",
    stop_type: "dropoff",
    order_refs: ["CUSTOM-STATS-V2"]
  }));
  assert.equal(rawCustomDrop.plannedMinutes, 52, "An older Custom Order snapshot must read its persisted raw stop time.");

  const legacyCustomOrders = planPayload.orders.map((order) => order.id === "CUSTOM-STATS-V2"
    ? { ...order, stopMinutes: null, raw: { ...order.raw, stop_minutes: null } }
    : order);
  const legacyCustomDrop = dispatchStatisticStopFromRow(row({
    orders: legacyCustomOrders,
    stop_id: "DROP-CUSTOM",
    stop_type: "dropoff",
    order_refs: ["CUSTOM-STATS-V2"],
    completed_at: "2026-07-22T12:33:00.000Z"
  }));
  assert.equal(legacyCustomDrop.plannedMinutes, 33, "A legacy Custom Order without stop time must retain delivery timing.");

  const truckSwitch = dispatchStatisticStopFromRow(row({
    stop_id: "truck-switch-LOAD-SWITCHED",
    stop_type: "truck_switch",
    order_refs: [],
    completed_at: "2026-07-22T12:12:00.000Z"
  }));
  assert.equal(truckSwitch.stopClass, "truck_switch");
  assert.equal(truckSwitch.plannedMinutes, 12);

  const groupedOrders = [{
    id: "GROUPED-SO",
    type: "SO",
    address: "100 Main Street, Toronto, ON",
    items: [{ lineRowId: "GS", pallets: 2, layers: 0 }]
  }, {
    id: "GROUPED-CUSTOM",
    type: "CUSTOM",
    customOrder: true,
    sourceTable: "dispatch_custom_orders",
    stopMinutes: 64,
    address: "100 MAIN STREET TORONTO ON",
    items: [{ lineRowId: "GC", pallets: 3, layers: 0 }]
  }];
  const groupedTrucks = [{
    id: "GROUPED-TRUCK",
    plate: "GROUPED-TRUCK",
    loads: [{
      id: "GROUPED-LOAD",
      name: "Grouped physical visit",
      driverLogin: "driver-v2",
      truckId: "GROUPED-TRUCK",
      truckPlate: "GROUPED-TRUCK",
      deliveryFixedMinutes: 33,
      minutesPerPallet: 2,
      stops: [
        { id: "GROUPED-DROP-A", type: "drop", orderId: "GROUPED-SO", lineRowIds: ["GS"], stopTimeOverrideMinutes: 45 },
        { id: "GROUPED-DROP-B", type: "drop", orderId: "GROUPED-CUSTOM", lineRowIds: ["GC"], stopTimeOverrideMinutes: 45 }
      ]
    }]
  }];
  const groupedRow = (overrides = {}) => row({
    orders: groupedOrders,
    trucks: groupedTrucks,
    truck_id: "GROUPED-TRUCK",
    truck_plate: "GROUPED-TRUCK",
    load_id: "GROUPED-LOAD",
    load_name: "Grouped physical visit",
    stop_id: "GROUPED-DROP-A",
    stop_type: "dropoff",
    order_refs: ["GROUPED-SO"],
    started_at: "2026-07-22T12:00:00.000Z",
    completed_at: "2026-07-22T12:20:00.000Z",
    ...overrides
  });
  const groupedStops = dispatchStatisticStopsFromRows([
    groupedRow(),
    groupedRow({
      job_id: "JOB-V2-B",
      stop_id: "GROUPED-DROP-B",
      order_refs: ["GROUPED-CUSTOM"],
      started_at: "2026-07-22T12:20:00.000Z",
      completed_at: "2026-07-22T12:50:00.000Z"
    })
  ]);
  assert.equal(groupedStops.length, 1, "Statistics must count adjacent same-address orders as one physical visit.");
  assert.deepEqual(groupedStops[0].stopIds, ["GROUPED-DROP-A", "GROUPED-DROP-B"]);
  assert.equal(groupedStops[0].plannedMinutes, 45, "A visit override must be counted exactly once in Statistics.");
  assert.equal(groupedStops[0].actualMinutes, 50);
  assert.equal(groupedStops[0].overrunMinutes, 5);
  assert.equal(groupedStops[0].pallets, 5);
  assert.deepEqual(groupedStops[0].orderRefs, ["GROUPED-SO", "GROUPED-CUSTOM"]);
  const groupedWithDerivedArrival = dispatchStatisticStopsFromRows([
    groupedRow({
      actual_arrival_at: "2026-07-22T12:05:00.000Z",
      actual_arrival_source: "samsara_gps_history",
      actual_arrival_confidence: "high"
    }),
    groupedRow({
      job_id: "JOB-V2-B-DERIVED",
      stop_id: "GROUPED-DROP-B",
      order_refs: ["GROUPED-CUSTOM"],
      started_at: "2026-07-22T12:20:00.000Z",
      completed_at: "2026-07-22T12:50:00.000Z",
      actual_arrival_at: "2026-07-22T12:05:00.000Z",
      actual_arrival_source: "samsara_gps_history",
      actual_arrival_confidence: "high"
    })
  ]);
  assert.equal(groupedWithDerivedArrival[0].actualMinutes, 45, "A shared derived arrival must measure one physical visit instead of summing overlapping logical rows.");
  assert.equal(groupedWithDerivedArrival[0].pwaStartedAt, "2026-07-22T12:00:00.000Z");
  const partiallyRecordedVisit = dispatchStatisticStopsFromRows([groupedRow()]);
  assert.equal(partiallyRecordedVisit[0].status, "in_progress", "A physical visit remains in progress until every logical job is complete.");
  assert.equal(partiallyRecordedVisit[0].plannedMinutes, 45);
  assert.equal(partiallyRecordedVisit[0].overrunMinutes, 0);

  const automaticGroupedTrucks = structuredClone(groupedTrucks);
  for (const stop of automaticGroupedTrucks[0].loads[0].stops) delete stop.stopTimeOverrideMinutes;
  const automaticGrouped = dispatchStatisticStopsFromRows([
    groupedRow({ trucks: automaticGroupedTrucks }),
    groupedRow({
      trucks: automaticGroupedTrucks,
      job_id: "JOB-V2-B-AUTO",
      stop_id: "GROUPED-DROP-B",
      order_refs: ["GROUPED-CUSTOM"]
    })
  ]);
  assert.equal(
    automaticGrouped[0].plannedMinutes,
    64,
    "A mixed Custom visit must use max(driver grouped rule, Custom duration), never sum both logical stops."
  );

  console.log(JSON.stringify({ ok: true, tests: 29 }));
} finally {
  await closeDb();
}
