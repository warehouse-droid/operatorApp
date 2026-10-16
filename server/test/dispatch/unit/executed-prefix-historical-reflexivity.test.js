import assert from "node:assert/strict";
import test from "node:test";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";

const plan = {orders: [{id: "SO-HISTORY",type: "SO",pallets: 1,pickupLocations: ["3445"],items: []}],
  trucks: [{id: "truck",plate: "HISTORY",driverLogin: "driver",loads: [{id: "load",stops: [
    {id: "old-pick",type: "pick",location: "3445"},
    {id: "old-drop",type: "drop",orderId: "SO-HISTORY",dropAddress: "100 History Street"}]}]}]};
const activity = [{status: "complete",stop_type: "dropoff",load_id: "load",
  stop_id: "later-version-drop",order_refs: ["SO-HISTORY"]}];

test("an identical historical load is preserved even when later activity uses another stop ID",() => {
  assert.equal(evaluateExecutedPrefixPolicy({previousPlan: plan,nextPlan: structuredClone(plan),activity}).allowed,true);
});

test("missing historical activity stop IDs conservatively protect actual load changes",() => {
  const changed = structuredClone(plan);
  changed.trucks[0].loads[0].stops[1].dropAddress = "200 Changed Street";
  assert.equal(evaluateExecutedPrefixPolicy({previousPlan: plan,nextPlan: changed,activity}).allowed,false);
});
