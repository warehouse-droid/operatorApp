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
assert.equal(approachJobs[approachIndex].fromLocation, "Customer 1");
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

const configuredOwnYardPlan = structuredClone(plan);
configuredOwnYardPlan.summary = { ownYardCodes: ["CUSTOM-YARD"] };
configuredOwnYardPlan.orders[0].destinationYard = "CUSTOM-YARD";
configuredOwnYardPlan.trucks[0].loads = [configuredOwnYardPlan.trucks[0].loads[0]];
configuredOwnYardPlan.trucks[1].base = "CUSTOM-YARD";
configuredOwnYardPlan.trucks[1].loads[0].switchYard = "CUSTOM-YARD";
const configuredOwnYardJobs = planJobsForDriver(configuredOwnYardPlan, "alex");
assert.equal(configuredOwnYardJobs.filter((job) => job.handoffTravel === true).length, 0);
assert.equal(configuredOwnYardJobs.filter((job) => job.stopType === "truck_switch").length, 1);

const poMultiDropHandoffPlan = structuredClone(plan);
poMultiDropHandoffPlan.trucks[0].loads = [poMultiDropHandoffPlan.trucks[0].loads[0]];
poMultiDropHandoffPlan.orders[0].destinationYard = "";
poMultiDropHandoffPlan.trucks[0].loads[0].stops[1] = {
  ...poMultiDropHandoffPlan.trucks[0].loads[0].stops[1],
  location: "PO header destination",
  dropLocation: "12441",
  lineRowIds: [101]
};
const poMultiDropHandoffJobs = planJobsForDriver(poMultiDropHandoffPlan, "alex");
assert.equal(poMultiDropHandoffJobs.filter((job) => job.handoffTravel === true).length, 0);
assert.equal(poMultiDropHandoffJobs.filter((job) => job.stopType === "truck_switch").length, 1);

const legacyPoMultiDropPlan = structuredClone(plan);
legacyPoMultiDropPlan.orders = [
  { id: "PO-LEGACY", type: "PO", sourceYard: "Vendor", address: "PO header destination" },
  legacyPoMultiDropPlan.orders[1]
];
legacyPoMultiDropPlan.trucks[0].loads = [legacyPoMultiDropPlan.trucks[0].loads[0]];
legacyPoMultiDropPlan.trucks[0].loads[0].id = "PO-LEGACY-LOAD";
legacyPoMultiDropPlan.trucks[0].loads[0].plannedFinishMinute = 500;
legacyPoMultiDropPlan.trucks[0].loads[0].stops = [
  stop("PO-LEGACY-P", "pick", "PO-LEGACY", "Vendor"),
  { ...stop("PO-LEGACY-D1", "drop", "PO-LEGACY", "2967"), lineRowIds: [101] },
  { ...stop("PO-LEGACY-D2", "drop", "PO-LEGACY", "12441"), dropoffKey: "location:15" }
];
legacyPoMultiDropPlan.trucks[1].loads[0].driverSequence = 1;
legacyPoMultiDropPlan.trucks[1].loads[0].switchYard = "12441";
const legacyPoMultiDropJobs = planJobsForDriver(legacyPoMultiDropPlan, "alex");
const legacyPoDrops = legacyPoMultiDropJobs.filter((job) => job.loadId === "PO-LEGACY-LOAD" && job.stopType === "dropoff");
assert.deepEqual(legacyPoDrops.map((job) => job.dropLocation), ["2967", "12441"]);
assert.deepEqual(legacyPoDrops.map((job) => job.lineRowIds), [["101"], []]);
assert.equal(legacyPoMultiDropJobs.filter((job) => job.handoffTravel === true).length, 0);
assert.equal(legacyPoMultiDropJobs.filter((job) => job.stopType === "truck_switch").length, 1);

const ordinarySoGenericYardPlan = structuredClone(approachPlan);
ordinarySoGenericYardPlan.trucks[0].loads[0].stops[1].location = "3445";
const ordinarySoGenericYardJobs = planJobsForDriver(ordinarySoGenericYardPlan, "alex");
const ordinarySoApproach = ordinarySoGenericYardJobs.find((job) => job.handoffTravel === true);
assert.ok(ordinarySoApproach, "An ordinary SO generic stop.location must not suppress the required truck-switch approach.");
assert.equal(ordinarySoApproach.fromLocation, "Customer 1");
assert.equal(ordinarySoApproach.toLocation, "3445");

const multiDropPlan = structuredClone(plan);
multiDropPlan.trucks = [multiDropPlan.trucks[0]];
multiDropPlan.trucks[0].loads = [{
  id: "PO-L1",
  name: "PO Multi-Drop",
  driverLogin: "alex",
  driverName: "Alex",
  truckId: "T1",
  truckPlate: "AA100",
  plannedStartMinute: 420,
  plannedFinishMinute: 520,
  stops: [
    stop("PO-P", "pick", "PO-1", "Vendor"),
    { ...stop("PO-D1", "drop", "PO-1", "12441"), dropLocation: "12441", dropAddress: "12441 Address", destinationLocationId: 15, lineRowIds: [101, 102] },
    { ...stop("PO-D2", "drop", "PO-1", "2967"), dropLocation: "2967", dropAddress: "2967 Address", destinationLocationId: 28, lineRowIds: [201, 202] }
  ]
}];
multiDropPlan.orders = [{ id: "PO-1", type: "PO", sourceYard: "Vendor", address: "Header Address" }];
const multiDropJobs = planJobsForDriver(multiDropPlan, "alex").filter((job) => job.stopType === "dropoff");
assert.equal(multiDropJobs.length, 2);
assert.deepEqual(multiDropJobs.map((job) => ({
  location: job.dropLocation,
  address: job.dropAddress,
  destinationLocationId: job.destinationLocationId,
  lineRowIds: job.lineRowIds
})), [
  { location: "12441", address: "12441 Address", destinationLocationId: 15, lineRowIds: ["101", "102"] },
  { location: "2967", address: "2967 Address", destinationLocationId: 28, lineRowIds: ["201", "202"] }
]);

const consolidatedManifestPlan = structuredClone(plan);
consolidatedManifestPlan.trucks = [consolidatedManifestPlan.trucks[0]];
consolidatedManifestPlan.orders = [
  { id: "CONSOLIDATED-A", type: "SO", sourceYard: "12441", address: "55 Shared Road, Toronto", items: [{ lineRowId: "A-1", sku: "ITEM-A", pieces: 4 }] },
  { id: "CONSOLIDATED-B", type: "SO", sourceYard: "12441", address: "55 Shared Road Toronto", items: [{ lineRowId: "B-1", sku: "ITEM-B", pallets: 2 }] },
  { id: "SEPARATE-C", type: "SO", sourceYard: "12441", address: "99 Separate Road, Toronto", items: [{ lineRowId: "C-1", sku: "ITEM-C", layers: 3 }] }
];
consolidatedManifestPlan.trucks[0].loads = [{
  id: "CONSOLIDATED-MANIFEST-LOAD",
  name: "Consolidated manifest",
  driverLogin: "alex",
  driverName: "Alex",
  truckId: "T1",
  truckPlate: "AA100",
  plannedStartMinute: 420,
  plannedFinishMinute: 520,
  stops: [
    stop("CONSOLIDATED-PICK", "pick", "CONSOLIDATED-A", "12441"),
    { ...stop("CONSOLIDATED-DROP-A", "drop", "CONSOLIDATED-A"), dropAddress: "55 Shared Road, Toronto", lineRowIds: ["A-1"] },
    { ...stop("CONSOLIDATED-DROP-B", "drop", "CONSOLIDATED-B"), dropAddress: "55 Shared Road Toronto", lineRowIds: ["B-1"] },
    { ...stop("SEPARATE-DROP-C", "drop", "SEPARATE-C"), dropAddress: "99 Separate Road, Toronto", lineRowIds: ["C-1"] }
  ]
}];
const consolidatedManifestJobs = planJobsForDriver(consolidatedManifestPlan, "alex");
const consolidatedPickup = consolidatedManifestJobs.find((job) => job.stopId === "CONSOLIDATED-PICK");
assert.deepEqual(
  consolidatedPickup.orderRefs,
  ["CONSOLIDATED-A", "CONSOLIDATED-B", "SEPARATE-C"],
  "A shared pickup manifest must include every order loaded at that pickup."
);
const consolidatedDrops = consolidatedManifestJobs.filter((job) => job.stopType === "dropoff");
assert.deepEqual(consolidatedDrops[0].orderRefs, ["CONSOLIDATED-A"],
  "A logical Driver completion must remain scoped to its own order.");
assert.deepEqual(consolidatedDrops[0].detailOrderRefs, ["CONSOLIDATED-A", "CONSOLIDATED-B"],
  "The first logical drop at a consolidated physical visit must display all involved orders.");
assert.deepEqual(consolidatedDrops[1].detailOrderRefs, ["CONSOLIDATED-A", "CONSOLIDATED-B"],
  "Every child of a consolidated physical visit must display the same complete manifest.");
assert.deepEqual(
  consolidatedDrops[0].physicalVisitJobIds,
  consolidatedDrops.slice(0, 2).map((job) => job.jobId),
  "The first consolidated drop must declare every logical job completed by its one-click physical visit action."
);
assert.deepEqual(
  consolidatedDrops[1].physicalVisitJobIds,
  consolidatedDrops.slice(0, 2).map((job) => job.jobId),
  "Every logical member must share the same physical-visit execution boundary."
);
assert.equal(consolidatedDrops[0].consolidatedPhysicalVisit, true);
assert.deepEqual(consolidatedDrops[0].detailOrderScopes.map((scope) => ({
  orderRef: scope.orderRef,
  lineRowIds: scope.lineRowIds
})), [
  { orderRef: "CONSOLIDATED-A", lineRowIds: ["A-1"] },
  { orderRef: "CONSOLIDATED-B", lineRowIds: ["B-1"] }
], "Consolidated display details must retain each order's exact item-line scope.");
assert.deepEqual(consolidatedDrops[2].detailOrderRefs, ["SEPARATE-C"],
  "A different physical address must not leak into the consolidated manifest.");
assert.deepEqual(consolidatedDrops[2].physicalVisitJobIds, [consolidatedDrops[2].jobId],
  "A different address must remain a separate one-click completion.");
assert.equal(consolidatedDrops[2].consolidatedPhysicalVisit, false);

const pickupOverridePlan = {
  id: 5634,
  planDate: "2026-07-24",
  ownYardCodes: ["3445", "2967", "12441"],
  orders: [
    {
      id: "GOA-5634-5636",
      type: "SO",
      sourceYard: "12441",
      pickupLocations: ["12441"],
      pickupAddressOverride: "2967 Kennedy Rd, Scarborough, ON M1V 1S9",
      childOrders: ["SOA05634", "SOA05636"],
      childOrderDetails: [
        { id: "SOA05634", type: "SO" },
        { id: "SOA05636", type: "SO" }
      ],
      address: "89 Remington Dr, Richmond Hill, ON"
    },
    {
      id: "SOB115974",
      type: "SO",
      sourceYard: "2967",
      pickupLocations: ["2967"],
      directPickupManifest: [{
        location: "2967",
        transferOrderRef: "TOB00720",
        salesOrderRef: "SOB115974",
        items: []
      }],
      address: "Customer 2"
    }
  ],
  trucks: [{
    id: "T2",
    plate: "BC71838",
    base: "3445",
    loads: [{
      id: "BC71838-L1",
      name: "Load 1",
      driverLogin: "alex",
      driverName: "Alex",
      truckId: "T2",
      truckPlate: "BC71838",
      plannedStartMinute: 660,
      plannedFinishMinute: 800,
      stops: [
        stop("GOA-P", "pick", "GOA-5634-5636", "12441"),
        stop("SOB-P", "pick", "SOB115974", "2967"),
        stop("GOA-D", "drop", "GOA-5634-5636", "89 Remington Dr"),
        stop("SOB-D", "drop", "SOB115974", "Customer 2")
      ]
    }]
  }]
};
const pickupOverrideJobs = planJobsForDriver(pickupOverridePlan, "alex");
const pickupOverrideTravel = pickupOverrideJobs.find((job) => job.stopType === "travel");
const coLocatedPickups = pickupOverrideJobs.filter((job) => job.stopType === "pickup");
assert.equal(pickupOverrideTravel?.toLocation, "2967");
assert.equal(pickupOverrideTravel?.location, "3445 to 2967");
assert.equal(
  pickupOverrideTravel?.jobId,
  "5634:T2:BC71838-L1:TRAVEL:3445:12441:",
  "The physical display label must not change the legacy travel-job identity."
);
assert.deepEqual(
  coLocatedPickups.map((job) => ({ location: job.location, pickupLocation: job.pickupLocation })),
  [
    { location: "2967", pickupLocation: "12441" },
    { location: "2967", pickupLocation: "2967" }
  ],
  "Co-located pickups must show the same physical yard while retaining their separate inventory identities."
);
assert.equal(coLocatedPickups[0].address, "2967 Kennedy Rd, Scarborough, ON M1V 1S9");
assert.deepEqual(coLocatedPickups[0].orderRefs, ["SOA05634", "SOA05636"]);
assert.ok(coLocatedPickups[1].orderRefs.includes("SOB115974"));
assert.ok(coLocatedPickups[1].orderRefs.includes("TOB00720"));
assert.notEqual(coLocatedPickups[0].jobId, coLocatedPickups[1].jobId);
assert.ok(
  pickupOverrideJobs.every((job) => !String(job.location || "").includes("12441")),
  "The driver projection must not tell the driver to travel to the logical 12441 yard."
);
assert.equal(
  pickupOverrideJobs.filter((job) =>
    job.stopType === "travel"
    && job.fromLocation === "2967"
    && job.toLocation === "2967"
  ).length,
  0,
  "Co-located logical pickups must not create a false inter-stop travel job."
);

const overrideEndBasePlan = {
  id: 6000,
  planDate: "2026-07-24",
  ownYardCodes: ["3445", "2967", "12441"],
  orders: [
    {
      id: "OVERRIDE-END",
      type: "SO",
      sourceYard: "12441",
      pickupLocations: ["12441"],
      pickupAddressOverride: "2967 Kennedy Rd, Scarborough, ON M1V 1S9"
    },
    { id: "NEXT", type: "SO", sourceYard: "3445", pickupLocations: ["3445"], address: "Next customer" }
  ],
  trucks: [{
    id: "T1",
    plate: "AA100",
    base: "3445",
    loads: [{
      id: "L1",
      name: "Override end",
      driverLogin: "alex",
      driverName: "Alex",
      truckId: "T1",
      truckPlate: "AA100",
      plannedStartMinute: 420,
      plannedFinishMinute: 480,
      driverSequence: 0,
      stops: [stop("OVERRIDE-P", "pick", "OVERRIDE-END", "12441")]
    }, {
      id: "L2",
      name: "Next load",
      driverLogin: "alex",
      driverName: "Alex",
      truckId: "T1",
      truckPlate: "AA100",
      plannedStartMinute: 500,
      plannedFinishMinute: 560,
      driverSequence: 1,
      stops: [
        stop("NEXT-P", "pick", "NEXT", "3445"),
        stop("NEXT-D", "drop", "NEXT", "Next customer")
      ]
    }]
  }]
};
const overrideEndJobs = planJobsForDriver(overrideEndBasePlan, "alex");
const nextLoadTravel = overrideEndJobs.find((job) => job.loadId === "L2" && job.stopType === "travel");
assert.equal(nextLoadTravel?.location, "2967 to 3445");
assert.equal(nextLoadTravel?.jobId, "6000:T1:L2:TRAVEL:12441:3445:");

const overrideReturnPlan = structuredClone(overrideEndBasePlan);
overrideReturnPlan.trucks[0].loads[1] = {
  id: "R1",
  name: "Manual Return",
  returnOnly: true,
  manual: true,
  returnYard: "3445",
  driverLogin: "alex",
  driverName: "Alex",
  truckId: "T1",
  truckPlate: "AA100",
  plannedStartMinute: 500,
  plannedFinishMinute: 530,
  driverSequence: 1,
  stops: []
};
const overrideReturnJob = planJobsForDriver(overrideReturnPlan, "alex")
  .find((job) => job.loadId === "R1" && job.stopType === "travel");
assert.equal(overrideReturnJob?.location, "2967 to 3445");
assert.equal(overrideReturnJob?.jobId, "6000:T1:R1:RETURN:12441:3445");

const overrideSwitchPlan = structuredClone(overrideEndBasePlan);
const switchedLoad = overrideSwitchPlan.trucks[0].loads.pop();
switchedLoad.id = "S2";
switchedLoad.truckId = "T2";
switchedLoad.truckPlate = "BB200";
switchedLoad.switchYard = "3445";
overrideSwitchPlan.trucks.push({
  id: "T2",
  plate: "BB200",
  base: "3445",
  loads: [switchedLoad]
});
const overrideSwitchApproach = planJobsForDriver(overrideSwitchPlan, "alex")
  .find((job) => job.loadId === "S2" && job.handoffTravel === true);
assert.equal(overrideSwitchApproach?.location, "2967 to 3445");
assert.equal(
  overrideSwitchApproach?.jobId,
  "6000:T1:S2:TRAVEL:12441:3445:TRUCK_SWITCH_APPROACH"
);

console.log(JSON.stringify({ ok: true, tests: 56, jobTypes: jobs.map((job) => job.stopType), approachJobTypes: approachJobs.map((job) => job.stopType) }));
