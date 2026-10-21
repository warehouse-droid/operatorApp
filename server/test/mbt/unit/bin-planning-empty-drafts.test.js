import assert from "node:assert/strict";
import test from "node:test";
import { assertPlanningSchedule } from "../../../src/mbt/bin-planning-repository.js";

test("confirmation skips unassigned BIN drafts but still protects timed reservations and return loads", () => {
  const plan = { trucks: [{ id: "bin", plate: "BIN-1", driverLogin: "driver", loads: [
    { id: "assigned", mbtPlanning: true, plannedStartMinute: 420, plannedFinishMinute: 480,
      stops: [{ mbt: { visitId: "visit" } }] },
    { id: "empty", mbtPlanning: true, plannedStartMinute: 450, plannedFinishMinute: null, stops: [] }
  ] }] };
  assert.doesNotThrow(() => assertPlanningSchedule(plan, true));
  plan.trucks[0].loads[1].plannedFinishMinute = 500;
  assert.throws(() => assertPlanningSchedule(plan, true), e => e.code === "DISPATCH_DRIVER_TIME_CONFLICT");
  plan.trucks[0].loads[1].plannedFinishMinute = null;
  plan.trucks[0].loads[1].returnOnly = true;
  assert.throws(() => assertPlanningSchedule(plan, true), e => e.details.conflicts[0].reason === "missing_interval");
});
