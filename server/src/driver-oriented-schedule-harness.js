import assert from "node:assert/strict";
import { planJobsForDriver } from "./driver-repository.js";

function stop(id, type, orderId, location = "12441") {
  return { id, type, orderId, location };
}

const plan = {
  id: 501,
  planDate: "2026-07-17",
  orders: [
    { id: "SO-1", type: "SO", sourceYard: "12441", address: "Customer 1" },
    { id: "SO-2", type: "SO", sourceYard: "12441", address: "Customer 2" }
  ],
  trucks: [
    {
      id: "T1",
      plate: "AA100",
      base: "12441",
      loads: [
        {
          id: "L1",
          name: "Load 1",
          driverLogin: "alex",
          driverName: "Alex",
          truckId: "T1",
          truckPlate: "AA100",
          switchYard: "12441",
          plannedStartMinute: 420,
          plannedFinishMinute: 480,
          driverSequence: 0,
          stops: [stop("L1-P", "pick", "SO-1"), stop("L1-D", "drop", "SO-1", "Customer 1")]
        },
        {
          id: "L1-R",
          name: "Return Load",
          returnOnly: true,
          returnYard: "12441",
          driverLogin: "alex",
          driverName: "Alex",
          truckId: "T1",
          truckPlate: "AA100",
          switchYard: "12441",
          plannedStartMinute: 480,
          plannedFinishMinute: 520,
          driverSequence: 1,
          stops: []
        }
      ]
    },
    {
      id: "T2",
      plate: "BB200",
      base: "12441",
      loads: [{
        id: "L2",
        name: "Load 2",
        driverLogin: "alex",
        driverName: "Alex",
        truckId: "T2",
        truckPlate: "BB200",
        switchYard: "12441",
        parkingSpot: "B2",
        truckSwitchMinutes: 10,
        plannedStartMinute: 530,
        plannedFinishMinute: 600,
        driverSequence: 2,
        stops: [stop("L2-P", "pick", "SO-2"), stop("L2-D", "drop", "SO-2", "Customer 2")]
      }]
    }
  ]
};

const jobs = planJobsForDriver(plan, "alex");
const switchJobs = jobs.filter((job) => job.stopType === "truck_switch");
assert.equal(switchJobs.length, 1);
assert.equal(switchJobs[0].jobId, "501:alex:L2:TRUCK_SWITCH");
assert.equal(switchJobs[0].fromTruckPlate, "AA100");
assert.equal(switchJobs[0].nextTruckPlate, "BB200");
assert.equal(switchJobs[0].switchYard, "12441");
assert.equal(switchJobs[0].parkingSpot, "B2");
assert.equal(switchJobs[0].plannedSwitchMinute, 520);
assert.ok(jobs.findIndex((job) => job.stopType === "truck_switch") < jobs.findIndex((job) => job.loadId === "L2" && job.stopType === "pickup"));

const legacyPickup = jobs.find((job) => job.stopId === "L1-P");
assert.equal(legacyPickup.jobId, "501:T1:L1:L1-P");

const sameTruckPlan = structuredClone(plan);
sameTruckPlan.trucks[1].loads[0].truckId = "T1";
sameTruckPlan.trucks[1].loads[0].truckPlate = "AA100";
sameTruckPlan.trucks[1].id = "T1";
sameTruckPlan.trucks[1].plate = "AA100";
assert.equal(planJobsForDriver(sameTruckPlan, "alex").filter((job) => job.stopType === "truck_switch").length, 0);

const approachPlan = structuredClone(plan);
approachPlan.trucks[0].loads = [approachPlan.trucks[0].loads[0]];
approachPlan.trucks[1].loads[0].switchYard = "3445";
approachPlan.trucks[1].loads[0].handoffTravelMinutes = 35;
approachPlan.trucks[1].loads[0].handoffTravelFrom = "SO-1";
approachPlan.trucks[1].loads[0].handoffTravelTo = "3445";
approachPlan.trucks[1].loads[0].plannedStartMinute = 525;
const approachJobs = planJobsForDriver(approachPlan, "alex");
const approachIndex = approachJobs.findIndex((job) => job.handoffTravel === true);
const approachSwitchIndex = approachJobs.findIndex((job) => job.stopType === "truck_switch");
assert.ok(approachIndex >= 0);
assert.ok(approachIndex < approachSwitchIndex);
assert.equal(approachJobs[approachIndex].fromLocation, "SO-1");
assert.equal(approachJobs[approachIndex].toLocation, "3445");
assert.equal(approachJobs[approachIndex].truckPlate, "AA100");
assert.equal(approachJobs[approachIndex].plannedStartMinute, 480);
assert.equal(approachJobs[approachIndex].plannedFinishMinute, 515);

const returnAfterSwitchPlan = structuredClone(approachPlan);
returnAfterSwitchPlan.trucks[0].loads.push({
  id: "L3-R",
  name: "Return Load",
  returnOnly: true,
  returnYard: "12441",
  driverLogin: "alex",
  driverName: "Alex",
  truckId: "T1",
  truckPlate: "AA100",
  switchYard: "3445",
  handoffTravelMinutes: 30,
  handoffTravelFrom: "SO-2",
  handoffTravelTo: "3445",
  truckSwitchMinutes: 10,
  plannedStartMinute: 640,
  plannedFinishMinute: 680,
  driverSequence: 3,
  stops: []
});
const returnAfterSwitchJobs = planJobsForDriver(returnAfterSwitchPlan, "alex");
const switchedReturn = returnAfterSwitchJobs.find((job) => job.loadId === "L3-R" && job.handoffTravel !== true && job.stopType === "travel");
assert.equal(switchedReturn.fromLocation, "3445");
assert.equal(switchedReturn.toLocation, "12441");

console.log(JSON.stringify({ ok: true, tests: 19, jobTypes: jobs.map((job) => job.stopType), approachJobTypes: approachJobs.map((job) => job.stopType) }));
