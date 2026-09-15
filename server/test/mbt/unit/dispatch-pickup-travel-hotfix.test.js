import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb } from "../../../src/db.js";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import { validateDriverPwaStopReopen } from "../../../src/driver-pwa-repository.js";

after(closeDb);

function fixture() {
  return {
    id: "323", planDate: "2026-09-11",
    orders: [
      { id: "A", type: "SO", sourceYard: "2967", items: [{ sku: "STONE-A", pallets: 1 }] },
      { id: "B", type: "SO", sourceYard: "3445", items: [{ sku: "STONE-B", pallets: 2 }] }
    ],
    trucks: [{ id: "T4", plate: "BC71838", driverLogin: "dao", loads: [{
      id: "L4", name: "Load 4", driverLogin: "dao", driverSequence: 0,
      plannedStartMinute: 817,
      stops: [
        { id: "pickup-a", type: "pick", orderId: "A", orderRefs: ["A"], location: "2967" },
        { id: "pickup-b", type: "pick", orderId: "B", orderRefs: ["B"], location: "3445" },
        { id: "drop-a", type: "drop", orderId: "A", location: "Customer A" },
        { id: "drop-b", type: "drop", orderId: "B", location: "Customer B" }
      ]
    }] }]
  };
}

function travel(details = {}, stopId = "travel-customer-2967", status = "in_progress") {
  return { job_id: "travel-job", load_id: "L4", stop_type: "travel", stop_id: stopId, status, job_details: details };
}

function editPickup(previousPlan, index) {
  const nextPlan = structuredClone(previousPlan);
  nextPlan.orders[index].items[0].pallets += 1;
  nextPlan.orders.push({ id: "NEW", type: "SO", sourceYard: index ? "3445" : "2967", items: [{ sku: "NEW", pallets: 1 }] });
  nextPlan.trucks[0].loads[0].stops[index].orderRefs.push("NEW");
  nextPlan.trucks[0].loads[0].stops.push({ id: "drop-new", type: "drop", orderId: "NEW", location: "New customer" });
  return nextPlan;
}

for (const status of ["in_progress", "complete"]) {
  for (const [label, record] of [
    ["inter-load travel with no target", travel({}, "travel-customer-2967", status)],
    ["explicit target", travel({ toStopId: "pickup-a" }, "travel-customer-2967", status)],
    ["legacy target suffix", travel({}, "travel-customer-pickup-a", status)]
  ]) {
    test(`${status} ${label}: cargo remains editable until the pickup starts`, () => {
      const previousPlan = fixture();
      assert.deepEqual(evaluateExecutedPrefixPolicy({ previousPlan, nextPlan: editPickup(previousPlan, 0), activity: [record] }), { allowed: true, conflicts: [] });
    });
  }
}

test("a later pickup in an already-started load remains editable during travel", () => {
  const previousPlan = fixture();
  const activity = [
    { load_id: "L4", stop_type: "pickup", stop_id: "pickup-a", order_refs: ["A"], status: "complete" },
    travel({ toStopId: "pickup-b" })
  ];
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan, nextPlan: editPickup(previousPlan, 1), activity }).allowed, true);
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan, nextPlan: editPickup(previousPlan, 0), activity }).allowed, false);
});

test("starting that pickup locks its cargo for both active and completed pickup records", () => {
  const previousPlan = fixture();
  for (const status of ["in_progress", "complete"]) {
    const activity = [{ load_id: "L4", stop_type: "pickup", stop_id: "pickup-a", order_refs: ["A"], status }];
    assert.equal(evaluateExecutedPrefixPolicy({ previousPlan, nextPlan: editPickup(previousPlan, 0), activity }).allowed, false);
  }
});

test("travel still protects driver assignment and preceding physical stops", () => {
  const previousPlan = fixture();
  const reassigned = structuredClone(previousPlan);
  reassigned.trucks[0].loads[0].driverLogin = "another-driver";
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan, nextPlan: reassigned, activity: [travel()] }).allowed, false);
  const changedPrevious = editPickup(previousPlan, 0);
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan, nextPlan: changedPrevious, activity: [travel({ toStopId: "pickup-b" })] }).allowed, false);
});

for (const status of ["in_progress", "complete"]) {
  test(`${status} travel can be reopened with the existing safety gates`, () => {
    const context = { record: travel({}, "travel-a-b", status), routeIndex: 0 };
    assert.equal(validateDriverPwaStopReopen(context).allowed, true);
    assert.equal(validateDriverPwaStopReopen({ ...context, laterJobs: [{ status: "in_progress" }] }).code, "DRIVER_PWA_LATER_STOP_ACTIVE");
    assert.equal(validateDriverPwaStopReopen({ ...context, nonterminalOfflineCount: 1 }).code, "DRIVER_PWA_UNSYNCED_SERVER_EVENTS");
    assert.equal(validateDriverPwaStopReopen({ ...context, executingForegroundCount: 1 }).code, "DRIVER_PWA_ACTION_EXECUTING");
    assert.equal(validateDriverPwaStopReopen({ ...context, routeIndex: -1 }).code, "DRIVER_PWA_STOP_NO_LONGER_ASSIGNED");
  });
}

test("rest and truck switch remain excluded from reopening", () => {
  for (const stop_type of ["rest", "truck_switch"]) {
    assert.equal(validateDriverPwaStopReopen({ record: { ...travel(), stop_type }, routeIndex: 0 }).code, "DRIVER_PWA_STOP_TYPE_BLOCKED");
  }
});
