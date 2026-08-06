import assert from "node:assert/strict";
import test from "node:test";

import { planJobsForDriver } from "../../../src/driver-repository.js";

function plan(order) {
  return {
    id: "phase1-driver-bin-plan",
    planDate: "2098-04-18",
    orders: [order],
    trucks: [
      {
        id: "phase1-truck",
        plate: "P1-BIN",
        driverLogin: "phase1-driver",
        driver: "Phase 1 Driver",
        loads: [
          {
            id: "phase1-load",
            name: "Load 1",
            stops: [
              {
                id: "phase1-stop",
                type: "drop",
                orderId: order.id,
                location: "Phase 1 test site"
              }
            ]
          }
        ]
      }
    ],
    summary: {}
  };
}

test("F14/F15: the shared Driver projection rejects a BIN plan before creating PWA jobs", () => {
  const binPlan = plan({
    id: "00000000-0000-4000-8000-000000000301",
    type: "BIN",
    customer: "Phase 1 BIN customer",
    mbt: { visitId: "00000000-0000-4000-8000-000000000302" }
  });

  assert.throws(
    () => planJobsForDriver(binPlan, "phase1-driver"),
    (error) => error?.status === 409
      && error?.code === "MBT_DRIVER_BIN_DISABLED"
      && error?.message === "Driver BIN execution is disabled in Phase 1."
  );
});

test("F14/F15: the Driver projection rejects stop-level MBT identity without a top-level BIN order", () => {
  const ordinaryOrder = {
    id: "SO-PHASE-1-HIDDEN-BIN",
    type: "SO",
    customer: "Existing delivery"
  };
  const binPlan = plan(ordinaryOrder);
  binPlan.trucks[0].loads[0].stops[0].mbt = {
    visitId: "00000000-0000-4000-8000-000000000303"
  };

  assert.throws(
    () => planJobsForDriver(binPlan, "phase1-driver"),
    (error) => error?.status === 409
      && error?.code === "MBT_DRIVER_BIN_DISABLED"
      && error?.message === "Driver BIN execution is disabled in Phase 1."
  );
});

test("F15: the Driver projection remains available for existing non-BIN work", () => {
  const jobs = planJobsForDriver(plan({
    id: "SO-PHASE-1",
    type: "SO",
    customer: "Existing delivery"
  }), "phase1-driver");

  assert.ok(jobs.length >= 1);
  assert.ok(jobs.every((job) => job.driverLogin === "phase1-driver"));
});

test("P3-F18 non-regression: another driver's BIN assignment never blocks an ordinary Driver projection", () => {
  const ordinaryPlan = plan({
    id: "SO-PHASE-1-ORDINARY-DRIVER",
    type: "SO",
    customer: "Existing ordinary delivery"
  });
  ordinaryPlan.trucks.push({
    id: "phase3-bin-truck",
    plate: "P3-BIN-OTHER",
    driverLogin: "phase3-bin-driver",
    driver: "Phase 3 BIN Driver",
    loads: [{
      id: "phase3-bin-load",
      name: "BIN Load",
      stops: [{
        id: "phase3-bin-stop",
        type: "pickup",
        mbt: { visitId: "00000000-0000-4000-8000-000000000304" }
      }]
    }]
  });

  const jobs = planJobsForDriver(ordinaryPlan, "phase1-driver");
  assert.ok(jobs.length >= 1);
  assert.ok(jobs.every((job) => job.driverLogin === "phase1-driver"));
});
