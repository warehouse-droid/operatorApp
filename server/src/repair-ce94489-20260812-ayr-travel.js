import { closeDb, query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { digestDispatchPlan, dispatchPlanBoard } from "./dispatch-planner-performance.js";

const TARGET = Object.freeze({
  planId: 230,
  planDate: "2026-08-12",
  driverLogin: "mike",
  truckId: "T6",
  truckPlate: "CE94489",
  loadId: "T6-L1786482477031-da6088a553618",
  priorLoadId: "T6-L1786482470679-70d643470d973",
  orderRef: "SN1397965",
  pickupStopId: "stop-cbd6c52d-8792-4ca0-91eb-10777beb2ec7",
  dropStopId: "T6-L1786482477031-da6088a553618-SN1397965-1786482477031-3790fff2a098c",
  travelJobId: "230:T6:T6-L1786482477031-da6088a553618:TRAVEL:12441:Ayr%20Yard%20-%20Unilock:",
  origin: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
  pickup: "2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0",
  destination: "3445 Kennedy Road, Toronto, ON",
  startMinute: 735,
  rawLegMinutes: [131, 148],
  legMinutes: [170, 192],
  pickupStayMinutes: 35,
  dropStayMinutes: 40,
  travelTimePercent: 30,
  routeEstimateId: "14sx87i",
  routeSignature: "2026-08-12@pick||12441 Woodbine Avenue, Whitchurch-Stouffville, ON|12441 Woodbine Avenue, Whitchurch-Stouffville, ON|Start #0000749961|0>pick|SN1397965|2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0|2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0|2. Pickup Ayr Yard - Unilock|35>drop|SN1397965|3445 Kennedy Road, Toronto, ON|3445 Kennedy Road, Toronto, ON|3. Drop SN1397965|40@start:735@tolls:avoid@truckPct:30",
  firstGoogleCheckedAt: "2026-08-12T19:34:52.580Z",
  secondGoogleCheckedAt: "2026-08-12T19:42:31.017Z",
  secondLegDeparture: "2026-08-12T20:12:00.000Z",
  repairCode: "CE94489_AYR_GOOGLE_TRAFFIC_TIMING_REPAIRED",
  actor: "system:ce94489-20260812-ayr-travel-repair"
});

function text(value) {
  return String(value ?? "").trim();
}

function dateValue(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10);
}

function assertRepair(condition, message) {
  if (!condition) {
    throw Object.assign(new Error(message), { code: "CE94489_AYR_TRAVEL_REPAIR_ASSERTION_FAILED" });
  }
}

function loadById(trucks, loadId) {
  const matches = [];
  for (const truck of trucks || []) {
    for (const load of truck.loads || []) {
      if (text(load.id) === loadId) matches.push({ truck, load });
    }
  }
  assertRepair(matches.length === 1, `Expected load ${loadId} exactly once, found ${matches.length}.`);
  return matches[0];
}

function stopById(load, stopId) {
  const matches = (load.stops || []).filter((stop) => text(stop.id) === stopId);
  assertRepair(matches.length === 1, `Expected stop ${stopId} exactly once, found ${matches.length}.`);
  return matches[0];
}

function expectedTiming() {
  const pickupArrival = TARGET.startMinute + TARGET.legMinutes[0];
  const pickupDepart = pickupArrival + TARGET.pickupStayMinutes;
  const dropArrival = pickupDepart + TARGET.legMinutes[1];
  const finish = dropArrival + TARGET.dropStayMinutes;
  return { pickupArrival, pickupDepart, dropArrival, finish };
}

function expectedEstimate() {
  const rawDriveMinutes = TARGET.rawLegMinutes.reduce((sum, value) => sum + value, 0);
  const driveMinutes = TARGET.legMinutes.reduce((sum, value) => sum + value, 0);
  const stayMinutes = TARGET.pickupStayMinutes + TARGET.dropStayMinutes;
  return {
    rawDriveMinutes,
    driveMinutes,
    stayMinutes,
    totalMinutes: driveMinutes + stayMinutes,
    legMinutes: [...TARGET.legMinutes],
    rawLegMinutes: [...TARGET.rawLegMinutes],
    allowTolls: false,
    travelTimePercent: TARGET.travelTimePercent,
    routeEstimateId: TARGET.routeEstimateId,
    routeSignature: TARGET.routeSignature,
    source: "google_operator_verified",
    repairCode: TARGET.repairCode,
    googleEvidence: {
      firstLeg: {
        from: TARGET.origin,
        to: TARGET.pickup,
        durationInTrafficMinutes: TARGET.rawLegMinutes[0],
        checkedAt: TARGET.firstGoogleCheckedAt,
        evidence: "Operator compared the 12:47 empty reposition with Google Maps at 2h11."
      },
      secondLeg: {
        from: TARGET.pickup,
        to: TARGET.destination,
        durationInTrafficMinutes: TARGET.rawLegMinutes[1],
        departureTime: TARGET.secondLegDeparture,
        checkedAt: TARGET.secondGoogleCheckedAt
      }
    }
  };
}

function isExactRetry(load) {
  const timing = expectedTiming();
  const pickup = (load.stops || []).find((stop) => text(stop.id) === TARGET.pickupStopId);
  const drop = (load.stops || []).find((stop) => text(stop.id) === TARGET.dropStopId);
  return load.routeEstimate?.repairCode === TARGET.repairCode
    && Number(load.plannedFinishMinute) === timing.finish
    && Number(load.timing?.finish) === timing.finish
    && Number(pickup?.timing?.arrival) === timing.pickupArrival
    && Number(pickup?.timing?.depart) === timing.pickupDepart
    && Number(drop?.timing?.arrival) === timing.dropArrival
    && Number(drop?.timing?.depart) === timing.finish;
}

async function repair() {
  const dryRun = process.env.CE94489_AYR_TRAVEL_REPAIR_DRY_RUN === "1";
  const result = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    await query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [TARGET.driverLogin, TARGET.planDate]);

    const planResult = await query("SELECT * FROM dispatch_plans WHERE id = $1 FOR UPDATE", [TARGET.planId]);
    const snapshotResult = await query("SELECT * FROM dispatch_plan_snapshots WHERE plan_id = $1 FOR UPDATE", [TARGET.planId]);
    const assignmentResult = await query(
      "SELECT * FROM dispatch_plan_load_assignments WHERE plan_id = $1 AND load_id = $2 FOR UPDATE",
      [TARGET.planId, TARGET.loadId]
    );
    const travelRecordResult = await query(
      "SELECT * FROM driver_job_records WHERE plan_id = $1 AND job_id = $2 FOR SHARE",
      [TARGET.planId, TARGET.travelJobId]
    );

    assertRepair(planResult.rowCount === 1, "Dispatch plan 230 was not found.");
    assertRepair(snapshotResult.rowCount === 1, "Dispatch plan snapshot 230 was not found.");
    assertRepair(assignmentResult.rowCount === 1, "CE94489 Load 2 assignment was not found exactly once.");
    assertRepair(travelRecordResult.rowCount === 1, "Mike's active 12441-to-Ayr travel record was not found exactly once.");

    const planRow = planResult.rows[0];
    const snapshot = snapshotResult.rows[0];
    const assignment = assignmentResult.rows[0];
    const travelRecord = travelRecordResult.rows[0];
    assertRepair(text(planRow.status).toLowerCase() === "confirmed", "Plan 230 is no longer confirmed.");
    assertRepair(dateValue(planRow.plan_date) === TARGET.planDate, "Plan 230 date changed.");
    assertRepair(text(assignment.driver_login).toLowerCase() === TARGET.driverLogin, "Load 2 driver changed.");
    assertRepair(text(assignment.truck_plate).toUpperCase() === TARGET.truckPlate, "Load 2 truck changed.");
    assertRepair(text(travelRecord.load_id) === TARGET.loadId, "The active travel record moved to another load.");
    assertRepair(["in_progress", "complete"].includes(text(travelRecord.status).toLowerCase()), "The target travel record has no active execution evidence.");
    assertRepair(travelRecord.started_at, "The target empty reposition has no preserved actual departure time.");

    const orders = structuredClone(Array.isArray(snapshot.orders) ? snapshot.orders : []);
    const trucks = structuredClone(Array.isArray(snapshot.trucks) ? snapshot.trucks : []);
    const order = orders.find((candidate) => text(candidate.id) === TARGET.orderRef);
    assertRepair(order, `${TARGET.orderRef} is missing from plan 230.`);
    assertRepair(text(order.sourceAddress) === TARGET.pickup, "SN1397965 Ayr source address changed.");

    const prior = loadById(trucks, TARGET.priorLoadId);
    const target = loadById(trucks, TARGET.loadId);
    assertRepair(text(target.truck.id) === TARGET.truckId, "Load 2 parent truck changed.");
    assertRepair(text(target.truck.plate).toUpperCase() === TARGET.truckPlate, "Load 2 snapshot truck changed.");
    const priorLastStop = [...(prior.load.stops || [])].reverse().find((stop) => ["pick", "drop"].includes(text(stop.type).toLowerCase()));
    assertRepair(text(priorLastStop?.dropLocation) === "12441", "Load 1 no longer ends at 12441.");
    const pickup = stopById(target.load, TARGET.pickupStopId);
    const drop = stopById(target.load, TARGET.dropStopId);
    assertRepair(text(pickup.type).toLowerCase() === "pick", "The Ayr stop is no longer a pickup.");
    assertRepair(text(pickup.location) === "Ayr Yard - Unilock", "The Ayr pickup location changed.");
    assertRepair(text(drop.type).toLowerCase() === "drop", "The 3445 stop is no longer a drop.");
    assertRepair(text(drop.dropAddress) === TARGET.destination, "The Load 2 destination changed.");

    if (isExactRetry(target.load)) {
      return {
        exactRetry: true,
        planId: TARGET.planId,
        revision: Number(planRow.revision),
        loadId: TARGET.loadId,
        travelStatus: travelRecord.status,
        actualDeparture: travelRecord.started_at,
        timing: expectedTiming(),
        routeEstimate: target.load.routeEstimate
      };
    }

    const timing = expectedTiming();
    const estimate = expectedEstimate();
    const before = {
      revision: Number(planRow.revision),
      loadTiming: target.load.timing || null,
      plannedFinishMinute: target.load.plannedFinishMinute,
      pickupTiming: pickup.timing || null,
      dropTiming: drop.timing || null,
      routeEstimate: target.load.routeEstimate || null,
      assignmentFinishMinute: Number(assignment.planned_finish_minute),
      actualDeparture: travelRecord.started_at,
      travelStatus: travelRecord.status
    };

    target.load.routeEstimate = estimate;
    target.load.plannedStartMinute = TARGET.startMinute;
    target.load.plannedFinishMinute = timing.finish;
    target.load.timing = {
      ...(target.load.timing || {}),
      start: TARGET.startMinute,
      finish: timing.finish,
      scheduledStart: TARGET.startMinute,
      previousFinish: TARGET.startMinute
    };
    pickup.timing = { arrival: timing.pickupArrival, depart: timing.pickupDepart };
    drop.timing = { arrival: timing.dropArrival, depart: timing.finish };

    const currentPlan = {
      id: text(planRow.id),
      planId: text(planRow.id),
      planDate: TARGET.planDate,
      status: planRow.status,
      note: planRow.note || "",
      orders,
      trucks: Array.isArray(snapshot.trucks) ? snapshot.trucks : [],
      summary: snapshot.summary || {}
    };
    const previousBoard = dispatchPlanBoard(currentPlan);
    await query(
      `INSERT INTO dispatch_plan_snapshot_history (
         plan_id, plan_date, revision, orders, trucks, summary,
         original_saved_at, archive_reason, session_id,
         schema_version, plan_digest, order_count, truck_count, load_count, stop_count
       ) VALUES (
         $1, $2::date, $3, $4::jsonb, $5::jsonb, $6::jsonb,
         $7, 'before_ce94489_ayr_travel_repair', $8,
         $9, $10, $11, $12, $13, $14
       )`,
      [
        TARGET.planId,
        TARGET.planDate,
        Number(planRow.revision),
        JSON.stringify(snapshot.orders || []),
        JSON.stringify(snapshot.trucks || []),
        JSON.stringify(snapshot.summary || {}),
        snapshot.saved_at,
        TARGET.actor,
        Number(snapshot.schema_version || 2),
        snapshot.plan_digest || digestDispatchPlan(currentPlan),
        Number(snapshot.order_count ?? orders.length),
        Number(snapshot.truck_count ?? previousBoard.truckCount),
        Number(snapshot.load_count ?? previousBoard.loadCount),
        Number(snapshot.stop_count ?? previousBoard.stopCount)
      ]
    );

    const nextRevision = Number(planRow.revision) + 1;
    const nextPlan = { ...currentPlan, trucks };
    const nextBoard = dispatchPlanBoard(nextPlan);
    const nextDigest = digestDispatchPlan(nextPlan);
    await query(
      `UPDATE dispatch_plans
          SET revision = $2,
              updated_at = now()
        WHERE id = $1`,
      [TARGET.planId, nextRevision]
    );
    await query(
      `UPDATE dispatch_plan_snapshots
          SET trucks = $2::jsonb,
              saved_at = now(),
              plan_digest = $3,
              order_count = $4,
              truck_count = $5,
              load_count = $6,
              stop_count = $7
        WHERE plan_id = $1`,
      [
        TARGET.planId,
        JSON.stringify(trucks),
        nextDigest,
        orders.length,
        nextBoard.truckCount,
        nextBoard.loadCount,
        nextBoard.stopCount
      ]
    );
    await query(
      `UPDATE dispatch_plan_load_assignments
          SET planned_start_minute = $3,
              planned_finish_minute = $4,
              updated_at = now()
        WHERE plan_id = $1 AND load_id = $2`,
      [TARGET.planId, TARGET.loadId, TARGET.startMinute, timing.finish]
    );

    await writeDispatchAudit({
      action: "dispatch_google_traffic_timing_repaired",
      entityType: "dispatch_load",
      entityId: TARGET.loadId,
      orderId: TARGET.orderRef,
      loadId: TARGET.loadId,
      truckId: TARGET.truckId,
      planId: TARGET.planId,
      planDate: TARGET.planDate,
      operatorName: TARGET.actor,
      source: "dispatch_live_repair",
      before,
      after: {
        revision: nextRevision,
        loadTiming: target.load.timing,
        plannedFinishMinute: timing.finish,
        pickupTiming: pickup.timing,
        dropTiming: drop.timing,
        routeEstimate: estimate,
        assignmentFinishMinute: timing.finish,
        actualDeparture: travelRecord.started_at,
        travelStatus: travelRecord.status
      },
      details: {
        repairCode: TARGET.repairCode,
        emptyReposition: true,
        origin: TARGET.origin,
        pickup: TARGET.pickup,
        destination: TARGET.destination,
        note: "12:47 to 13:26 was a 39-minute generic fallback for the empty 12441-to-Ayr reposition, not Ayr yard service. Replaced both fallback legs with traffic-aware Google durations and retained the 35-minute Ayr service as its own interval."
      }
    });

    return {
      exactRetry: false,
      planId: TARGET.planId,
      revision: nextRevision,
      loadId: TARGET.loadId,
      travelStatus: travelRecord.status,
      actualDeparture: travelRecord.started_at,
      timing,
      routeEstimate: estimate,
      ...(dryRun ? { currentLiveState: before } : {})
    };
  }, { rollback: dryRun });
  return { ...result, dryRun };
}

try {
  console.log(JSON.stringify(await repair(), null, 2));
} finally {
  await closeDb();
}
