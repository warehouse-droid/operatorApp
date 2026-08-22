import assert from "node:assert/strict";
import {
  buildDispatchForecast,
  dispatchTorontoMinuteIso
} from "./dispatch-forecast-service.js";
import { planJobsForDriver } from "./driver-repository.js";
import { closeDb } from "./db.js";

function at(minute) {
  return dispatchTorontoMinuteIso("2026-08-01", minute);
}

const plan = {
  id: 9001,
  revision: 17,
  planDate: "2026-08-01",
  summary: { ownYardCodes: ["3445", "12441"] },
  orders: [
    { id: "PICK", type: "SO", sourceYard: "3445", address: "10 Customer Rd", items: [{ lineRowId: 1, pallets: 1 }] },
    { id: "A", type: "SO", sourceYard: "3445", address: "100 Main St, Toronto, ON", items: [{ lineRowId: 2, pallets: 1 }] },
    { id: "B", type: "SO", sourceYard: "3445", address: "100 MAIN ST TORONTO ON", items: [{ lineRowId: 3, pallets: 2 }] },
    { id: "C", type: "SO", sourceYard: "3445", address: "200 Main St, Toronto, ON", items: [{ lineRowId: 4, pallets: 1 }] },
    { id: "NEXT", type: "SO", sourceYard: "3445", address: "300 Main St, Toronto, ON", items: [{ lineRowId: 5, pallets: 1 }] }
  ],
  trucks: [{
    id: "T1",
    plate: "AA100",
    driver: "Alex",
    driverLogin: "alex",
    base: "12441",
    ownYardFixedMinutes: 30,
    vendorFixedMinutes: 30,
    deliveryFixedMinutes: 20,
    minutesPerPallet: 1,
    loads: [{
      id: "L1",
      name: "Load 1",
      driverLogin: "alex",
      driverName: "Alex",
      driverSequence: 0,
      timing: { start: 480, finish: 680 },
      stops: [
        { id: "P1", type: "pick", orderId: "PICK", location: "3445", timing: { arrival: 510, depart: 540 } },
        { id: "D1", type: "drop", orderId: "A", timing: { arrival: 570, depart: 590 } },
        { id: "D2", type: "drop", orderId: "B", timing: { arrival: 590, depart: 620 } },
        { id: "D3", type: "drop", orderId: "C", timing: { arrival: 630, depart: 651 } }
      ]
    }, {
      id: "L2",
      name: "Fixed future load",
      driverLogin: "alex",
      driverName: "Alex",
      driverSequence: 1,
      startMode: "fixed",
      timing: { start: 800, finish: 900 },
      stops: [
        { id: "P2", type: "pick", orderId: "NEXT", location: "3445", timing: { arrival: 830, depart: 830 } },
        { id: "D4", type: "drop", orderId: "NEXT", timing: { arrival: 870, depart: 891 } }
      ]
    }]
  }]
};

function record(stopId, status, startedMinute, completedMinute = null, extra = {}) {
  return {
    job_id: `${stopId}-job`,
    plan_id: plan.id,
    plan_date: plan.planDate,
    driver_login: "alex",
    truck_id: "T1",
    truck_plate: "AA100",
    load_id: extra.loadId || "L1",
    stop_id: stopId,
    stop_type: extra.stopType || (stopId.startsWith("P") ? "pickup" : "dropoff"),
    order_refs: extra.orderRefs || [],
    status,
    started_at: startedMinute === null ? null : at(startedMinute),
    completed_at: completedMinute === null ? null : at(completedMinute)
  };
}

try {
  assert.equal(dispatchTorontoMinuteIso("2026-08-01", 480), "2026-08-01T12:00:00.000Z", "Summer plans must use Toronto daylight time.");
  assert.equal(dispatchTorontoMinuteIso("2026-01-01", 480), "2026-01-01T13:00:00.000Z", "Winter plans must use Toronto standard time.");
  assert.equal(dispatchTorontoMinuteIso("2026-08-01", 1500), "2026-08-02T05:00:00.000Z", "Minute boundaries beyond 24 hours must retain the next Toronto calendar day.");

  const baseline = buildDispatchForecast(plan, [], { now: at(480) });
  assert.equal(baseline.planId, "9001");
  assert.equal(baseline.planRevision, 17);
  assert.equal(baseline.timeZone, "America/Toronto");
  const firstPickup = baseline.stops.find((stop) => stop.stopId === "P1");
  assert.equal(firstPickup.plannedArrival, at(510));
  assert.equal(firstPickup.plannedLeave, at(540));
  const currentDriverRule = buildDispatchForecast(plan, [], {
    now: at(480),
    driverProfiles: [{ login: "alex", ownYardFixedMinutes: 45, deliveryFixedMinutes: 20, minutesPerPallet: 1 }]
  });
  assert.equal(currentDriverRule.stops.find((stop) => stop.stopId === "P1").plannedLeave, at(555), "The assigned driver's current setup rule must override stale snapshot timing profiles.");
  const grouped = baseline.stops.find((stop) => stop.stopId === "D1");
  assert.deepEqual(grouped.visitStopIds, ["D1", "D2"]);
  assert.equal(grouped.plannedLeave, at(593), "A grouped delivery must use one fixed time plus its aggregate three-pallet footprint.");
  assert.equal(baseline.stops.find((stop) => stop.stopId === "D3").plannedArrival, at(603), "The corrected route must retain only the old ten-minute travel gap after a grouped visit.");
  assert.equal(baseline.stops.find((stop) => stop.stopId === "P2").plannedArrival, at(830), "A fixed later load must keep its published baseline after an earlier dwell correction.");

  const autoInheritedPlan = structuredClone(plan);
  autoInheritedPlan.trucks[0].loads[1].startMode = "auto";
  autoInheritedPlan.trucks[0].loads[1].start = "";
  const autoInherited = buildDispatchForecast(autoInheritedPlan, [], { now: at(480) });
  assert.equal(autoInherited.stops.find((stop) => stop.stopId === "P2").plannedArrival, at(803), "An automatic later load must move earlier by the removed legacy dwell while preserving its original inter-load gap.");
  assert.equal(
    autoInherited.travelLegs.find((leg) => leg.loadId === "L2" && leg.kind === "start")?.plannedLeave,
    at(773),
    "The automatic load's start-travel event must move with its inherited baseline."
  );

  const coLocatedPlan = structuredClone(plan);
  coLocatedPlan.orders.find((order) => order.id === "A").address = "3445 Kennedy Rd, Toronto ON";
  coLocatedPlan.trucks[0].loads = [{
    ...coLocatedPlan.trucks[0].loads[0],
    timing: { start: 480, finish: 570 },
    stops: [
      { id: "P1", type: "pick", orderId: "PICK", location: "3445", timing: { arrival: 510, depart: 540 } },
      { id: "D1", type: "drop", orderId: "A", timing: { arrival: 540, depart: 561 } }
    ]
  }];
  const coLocated = buildDispatchForecast(coLocatedPlan, [], { now: at(480) });
  assert.equal(
    coLocated.travelLegs.filter((leg) => leg.kind === "inter_stop").length,
    0,
    "Formatting variants of the same physical yard address must not create a false travel leg."
  );

  const zeroPickupPlan = structuredClone(plan);
  zeroPickupPlan.trucks[0].loads[0].stops[0].timing.depart = 510;
  const zeroPickup = buildDispatchForecast(zeroPickupPlan, [], { now: at(480) });
  assert.equal(zeroPickup.stops.find((stop) => stop.stopId === "P1").plannedLeave, at(540), "A persisted zero-minute first pickup must be restored from its driver rule.");
  assert.equal(zeroPickup.stops.find((stop) => stop.stopId === "D1").plannedArrival, at(600), "Correcting a zero-minute pickup must advance the remaining route while retaining its raw travel gap.");

  const pickupComplete = [record("P1", "complete", 530, 560)];
  const shifted = buildDispatchForecast(plan, pickupComplete, { now: at(565) });
  assert.equal(shifted.stops.find((stop) => stop.stopId === "D1").forecastArrival, at(590), "A completed visit must shift the downstream lane from its actual leave.");
  assert.equal(shifted.stops.find((stop) => stop.stopId === "P2").forecastArrival, at(850), "A fixed future load must still move with the live lane forecast.");

  const inProgress = buildDispatchForecast(plan, [record("P1", "in_progress", 540)], { now: at(585) });
  assert.equal(inProgress.stops.find((stop) => stop.stopId === "P1").forecastLeave, at(570), "An arrival-only visit must stay anchored to the driver timestamp instead of drifting with wall-clock polling.");
  const durationWins = buildDispatchForecast(plan, [record("P1", "in_progress", 540)], { now: at(550) });
  assert.equal(durationWins.stops.find((stop) => stop.stopId === "P1").forecastLeave, at(570), "An arrival-only visit must retain its planned service duration regardless of poll time.");

  const partialGroup = buildDispatchForecast(plan, [
    record("D1", "complete", 600, 612),
    record("D2", "in_progress", 612)
  ], { now: at(615) }).stops.find((stop) => stop.stopId === "D1");
  assert.equal(partialGroup.status, "in_progress");
  assert.equal(partialGroup.actualArrival, at(600));
  assert.equal(partialGroup.actualLeave, null, "A physical visit cannot leave until every logical member is complete.");

  const completedGroup = buildDispatchForecast(plan, [
    record("D1", "complete", 600, 612),
    record("D2", "complete", 612, 623)
  ], { now: at(625) });
  const completedVisit = completedGroup.stops.find((stop) => stop.stopId === "D1");
  assert.equal(completedVisit.actualLeave, at(623));
  assert.equal(completedVisit.status, "complete");
  assert.equal(completedGroup.stops.find((stop) => stop.stopId === "D3").forecastArrival, at(633), "A completed visit must reset the next forecast from its actual completion variance.");

  const inferred = buildDispatchForecast(plan, [
    record("D1", "complete", 600, 612),
    record("D2", "complete", 612, 623),
    record("D3", "in_progress", 660)
  ], { now: at(661) }).travelLegs.find((leg) => leg.kind === "inter_stop" && leg.to.includes("200 Main"));
  assert.ok(inferred, "The non-co-located physical visits need an inter-stop travel leg.");
  assert.equal(inferred.source, "destination_stop_arrival");
  assert.equal(inferred.actualLeave, at(623));
  assert.equal(inferred.actualArrival, at(660));

  const derivedArrivalRecords = [
    record("D1", "complete", 600, 612),
    record("D2", "complete", 612, 623),
    {
      ...record("D3", "complete", 660, 680),
      actual_arrival_at: at(654),
      actual_arrival_source: "samsara_gps_history",
      actual_arrival_confidence: "high",
      actual_arrival_algorithm_version: "terminal-cluster-v1"
    }
  ];
  const derivedArrivalForecast = buildDispatchForecast(plan, derivedArrivalRecords, { now: at(681) });
  const derivedStop = derivedArrivalForecast.stops.find((stop) => stop.stopId === "D3");
  const derivedTravel = derivedArrivalForecast.travelLegs.find((leg) =>
    leg.kind === "inter_stop" && leg.to.includes("200 Main")
  );
  assert.equal(derivedStop.actualArrival, at(654), "The canonical arrival must replace the auto-start PWA timestamp in forecast output.");
  assert.equal(derivedStop.actualArrivalSource, "samsara_gps_history");
  assert.equal(derivedStop.actualArrivalConfidence, "high");
  assert.equal(derivedTravel.actualArrival, at(654), "The preceding travel leg must end at the same canonical stop arrival.");
  assert.equal(derivedTravel.source, "destination_stop_arrival");
  assert.equal(derivedArrivalRecords[2].started_at, at(660), "Forecasting must never rewrite immutable PWA evidence.");

  const expectedStart = planJobsForDriver(plan, "alex").find((job) => job.stopType === "travel" && job.loadId === "L1" && Number(job.sequence?.stopIndex) < 0);
  assert.ok(expectedStart, "Fixture must produce a Driver PWA start-travel job.");
  const explicitTravelRecord = record(expectedStart.stopId, "complete", 485, 515, {
    stopType: "travel",
    orderRefs: []
  });
  explicitTravelRecord.job_id = expectedStart.jobId;
  const explicit = buildDispatchForecast(plan, [explicitTravelRecord], { now: at(520) }).travelLegs.find((leg) => leg.jobId === expectedStart.jobId);
  assert.equal(explicit.kind, "start");
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.actualLeave, at(485));
  assert.equal(explicit.actualArrival, at(515));

  const transitionPlan = {
    id: 9002,
    revision: 1,
    planDate: "2026-08-01",
    summary: { ownYardCodes: ["3445", "12441", "2967"] },
    orders: [],
    trucks: [{
      id: "TA",
      plate: "OLD100",
      driver: "Alex",
      driverLogin: "alex",
      base: "3445",
      loads: [{
        id: "LA",
        name: "Previous return",
        driverLogin: "alex",
        driverName: "Alex",
        driverSequence: 0,
        returnOnly: true,
        returnYard: "12441",
        returnMinutes: 60,
        timing: { start: 540, finish: 600 },
        plannedStartMinute: 540,
        plannedFinishMinute: 600
      }]
    }, {
      id: "TB",
      plate: "NEW200",
      driver: "Alex",
      driverLogin: "alex",
      base: "2967",
      loads: [{
        id: "LB",
        name: "Next return",
        driverLogin: "alex",
        driverName: "Alex",
        driverSequence: 1,
        truckPlate: "NEW200",
        startMode: "fixed",
        start: "11:20",
        returnOnly: true,
        returnYard: "12441",
        returnMinutes: 60,
        switchYard: "2967",
        truckSwitchMinutes: 10,
        handoffTravelMinutes: 30,
        handoffTravelFrom: "12441",
        handoffTravelTo: "2967",
        timing: {
          start: 680,
          finish: 740,
          previousFinish: 600,
          restBefore: 40,
          handoffTravel: { from: "12441", to: "2967", minutes: 30, start: 640, finish: 670 },
          switchStart: 670
        },
        plannedStartMinute: 680,
        plannedFinishMinute: 740
      }]
    }]
  };
  const transitionJobs = planJobsForDriver(transitionPlan, "alex");
  const previousReturnJob = transitionJobs.find((job) => job.loadId === "LA" && job.stopType === "travel");
  const switchJob = transitionJobs.find((job) => job.loadId === "LB" && job.stopType === "truck_switch");
  assert.ok(previousReturnJob, "Fixture must expose the previous return travel job.");
  assert.ok(switchJob, "Fixture must expose the exact truck-switch job.");
  const transitionRecord = (job, status, startedMinute, completedMinute = null) => ({
    job_id: job.jobId,
    plan_id: transitionPlan.id,
    plan_date: transitionPlan.planDate,
    driver_login: "alex",
    truck_id: job.truckId,
    truck_plate: job.truckPlate,
    load_id: job.loadId,
    load_name: job.loadName,
    stop_id: job.stopId,
    stop_type: job.stopType,
    order_refs: [],
    status,
    started_at: at(startedMinute),
    completed_at: completedMinute === null ? null : at(completedMinute)
  });

  const delayedTransition = buildDispatchForecast(transitionPlan, [
    transitionRecord(previousReturnJob, "complete", 560, 620)
  ], { now: at(625) });
  const delayedRest = delayedTransition.timelineEvents.find((event) => event.kind === "rest" && event.loadId === "LB");
  const delayedSwitch = delayedTransition.timelineEvents.find((event) => event.kind === "truck_switch" && event.loadId === "LB");
  const delayedApproach = delayedTransition.travelLegs.find((leg) => leg.kind === "handoff" && leg.loadId === "LB");
  const delayedNextReturn = delayedTransition.travelLegs.find((leg) => leg.kind === "return" && leg.loadId === "LB");
  assert.deepEqual(
    [delayedRest.forecastStart, delayedRest.forecastEnd],
    [at(620), at(660)],
    "A delayed prior load must move the complete planned rest/wait interval."
  );
  assert.deepEqual(
    [delayedApproach.forecastLeave, delayedApproach.forecastArrival],
    [at(660), at(690)],
    "The switch-approach travel must follow the shifted rest without a gap or overlap."
  );
  assert.deepEqual(
    [delayedSwitch.forecastStart, delayedSwitch.forecastEnd],
    [at(690), at(700)],
    "The planned truck switch must follow the shifted approach travel."
  );
  assert.equal(delayedNextReturn.forecastLeave, at(700), "The next load must start at the shifted switch boundary.");
  assert.equal(
    delayedTransition.loads.find((load) => load.loadId === "LB").forecastStart,
    at(660),
    "Auxiliary rest/switch events must not redefine the existing load forecast boundary."
  );

  const exactSwitchTransition = buildDispatchForecast(transitionPlan, [
    transitionRecord(previousReturnJob, "complete", 560, 620),
    transitionRecord(switchJob, "in_progress", 690),
    transitionRecord(switchJob, "complete", 695, 705)
  ], { now: at(710) });
  const exactSwitch = exactSwitchTransition.timelineEvents.find((event) => event.kind === "truck_switch");
  assert.equal(exactSwitch.jobId, switchJob.jobId);
  assert.equal(exactSwitch.source, "explicit");
  assert.equal(exactSwitch.status, "complete");
  assert.equal(exactSwitch.actualStart, at(695));
  assert.equal(exactSwitch.actualEnd, at(705));
  assert.equal(
    exactSwitchTransition.travelLegs.find((leg) => leg.kind === "return" && leg.loadId === "LB").forecastLeave,
    at(705),
    "The durable exact switch completion must anchor the next load even when an older retry status is also present."
  );

  console.log("Dispatch live forecast checks passed.");
} finally {
  await closeDb();
}
