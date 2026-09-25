import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before as beforeAll } from "node:test";
import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { executeActualArrivalRun } from "../../../src/dispatch-actual-arrival-service.js";
import {
  applyActualArrivalRun, createHistoricalActualArrivalRun, getActualArrivalRun,
  listActualArrivalRouteRecords
} from "../../../src/dispatch-actual-arrival-repository.js";
import { listDriverJobStatuses } from "../../../src/driver-repository.js";
import { buildDispatchForecast } from "../../../src/dispatch-forecast-service.js";

let rollback;
const originalFetch = globalThis.fetch;
const originalToken = config.samsara.apiToken;
const calls = [];
let gps = [];
let historyFailureBefore = "";
let truncatedHistory = false;
const originalNow = Date.now;
beforeAll(async () => {
  rollback = await beginRollbackContext();
  config.samsara.apiToken = "arrival-repair-test-token";
  globalThis.fetch = async (raw, options) => {
    const url = new URL(raw);
    assert.equal(url.origin, "https://api.samsara.com");
    assert.equal(options.method, "GET");
    calls.push(url);
    if (url.pathname === "/fleet/vehicles") {return new Response(JSON.stringify({ data: [{ id: "arrival-test", licensePlate: "ARRIVAL-TEST" }] }));}
    if (url.pathname === "/v1/fleet/trips") {return new Response(JSON.stringify({ trips: [] }));}
    assert.equal(url.pathname, "/fleet/vehicles/stats/history");
    if (historyFailureBefore && url.searchParams.get("startTime") < historyFailureBefore) {
      return new Response(JSON.stringify({ message: "Simulated earlier history unavailable" }), { status: 503 });
    }
    const points = gps.filter(point => point.time >= url.searchParams.get("startTime") && point.time <= url.searchParams.get("endTime"));
    if (truncatedHistory && url.searchParams.get("startTime") === leave) {
      const now = originalNow();
      Date.now = () => now + 60000;
      return new Response(JSON.stringify({ data: [{ id: "arrival-test", gps: points }], pagination: { hasNextPage: true, endCursor: "next" } }));
    }
    return new Response(JSON.stringify({ data: [{ id: "arrival-test", gps: points }] }));
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  config.samsara.apiToken = originalToken;
  Date.now = originalNow;
  await rollback?.rollback();
  await closeDb();
});

const address = "100 Arrival Test Road, Toronto, ON";
const leave = "2026-09-14T10:46:48.000Z";
const complete = "2026-09-14T11:28:49.000Z";
const expected = { expectedAddress: address, expectedLatitude: 43.8, expectedLongitude: -79.3 };
const sample = time => ({ time, latitude: 43.8, longitude: -79.3, speedMilesPerHour: 0 });

async function fixture({ sameSite = false } = {}) {
  calls.length = 0;
  historyFailureBefore = "";
  truncatedHistory = false;
  Date.now = originalNow;
  gps = [sample("2026-09-14T11:15:00.000Z"), sample("2026-09-14T11:16:10.000Z")];
  const key = crypto.randomUUID();
  const driver = `arrival-${key}`;
  const ids = [];
  for (const [stop, type, destination, started, ended] of [
    ["P1", "pickup", sameSite ? address : "2967 Kennedy Road, Toronto, ON", "2026-09-14T10:30:00.000Z", leave],
    ["D1", "dropoff", address, leave, complete]
  ]) {
    const inserted = await query(`INSERT INTO driver_job_records (
      job_id,plan_date,driver_login,truck_plate,load_id,load_name,stop_id,stop_type,
      order_refs,photo_data_urls,status,started_at,completed_at,job_details
    ) VALUES ($1,'2026-09-14',$2,'ARRIVAL-TEST',$3,'Load 1',$4,$5,'["TEST-ORDER"]','[]','complete',$6,$7,$8::jsonb) RETURNING *`,
    [`${key}-${stop}`, driver, key, stop, type, started, ended, JSON.stringify({ address: destination, physicalVisitJobIds: [`${key}-${stop}`] })]);
    ids.push(inserted.rows[0]);
  }
  const verify = async ({ login = driver, jobId = ids[1].job_id, details = expected, checkedAt = "2026-09-14T10:47:00.000Z" } = {}) => {
    await query(`INSERT INTO driver_location_verifications (
      verification_id,driver_login,job_id,status,source,details,checked_at,expires_at
    ) VALUES ($1,$2,$3,'warning','samsara',$4::jsonb,$5::timestamptz,$5::timestamptz+interval '5 minutes')`,
    [crypto.randomUUID(), login, jobId, JSON.stringify(details), checkedAt]);
  };
  const preview = async ({ automatic = false } = {}) => {
    const run = await createHistoricalActualArrivalRun({ planDate: "2026-09-14", driverLogin: driver, requestedBy: "test:arrival-repair" });
    await query("UPDATE dispatch_actual_arrival_runs SET status='running',attempt_count=2 WHERE run_id=$1", [run.runId]);
    await executeActualArrivalRun({ ...run, ...(automatic ? { mode: "automatic", triggerJobRecordId: Number(ids[1].id) } : {}), attemptCount: 2 });
    return getActualArrivalRun(run.runId);
  };
  const plan = {
    id: key, planDate: "2026-09-14", revision: 1, summary: { ownYardCodes: ["2967"] },
    orders: [{ id: "TEST-ORDER", type: "SO", sourceYard: "2967", address, items: [{ pallets: 1 }] }],
    trucks: [{ id: "T1", plate: "ARRIVAL-TEST", driverLogin: driver, base: "2967", loads: [{
      id: key, name: "Load 1", driverLogin: driver, driverSequence: 0, timing: { start: 390, finish: 460 }, stops: [
        { id: "P1", type: "pick", orderId: "TEST-ORDER", location: "2967", timing: { arrival: 390, depart: 407 } },
        { id: "D1", type: "drop", orderId: "TEST-ORDER", timing: { arrival: 435, depart: 460 } }
      ]
    }] }]
  };
  return { driver, ids, verify, preview, plan };
}

test("stored verification coordinates resolve, apply idempotently, and correct the travel boundary without changing driver evidence", () => rollback.run(async () => {
  const f = await fixture();
  await f.verify();
  const before = (await query("SELECT * FROM driver_job_records WHERE driver_login=$1 ORDER BY id", [f.driver])).rows;
  const run = await f.preview();
  assert.equal(run.results[1].resolutionStatus, "resolved");
  assert.equal(run.results[1].source, "samsara_gps_history");
  assert.equal(run.results[1].evidence.destinationSource, "driver_location_verification");
  assert.equal(run.results[1].proposedArrivalAt, "2026-09-14T11:15:00.000Z");
  assert.equal(run.results[0].resolutionStatus, "first_stop");
  for (let n = 0; n < 2; n++) {assert.equal((await applyActualArrivalRun(run.runId, { expectedResultVersion: run.resultVersion, appliedBy: "test:repair" })).status, "applied");}
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE driver_login=$1 ORDER BY id", [f.driver])).rows, before);
  const rows = await listActualArrivalRouteRecords({ planDate: "2026-09-14", driverLogin: f.driver });
  const forecast = buildDispatchForecast(f.plan, rows);
  const leg = forecast.travelLegs.find(row => row.kind === "inter_stop");
  assert.equal(leg.actualLeave, leave);
  assert.equal(leg.actualArrival, "2026-09-14T11:15:00.000Z");
  assert.equal(forecast.stops.find(row => row.stopId === "D1").actualArrival, leg.actualArrival);
}));

test("a newer wrong-address verification does not hide an older matching destination", () => rollback.run(async () => {
  const f = await fixture();
  await f.verify();
  await f.verify({ details: { ...expected, expectedAddress: "999 Different Road" }, checkedAt: "2026-09-14T11:00:00.000Z" });
  assert.equal((await f.preview()).results[1].proposedArrivalAt, "2026-09-14T11:15:00.000Z");
}));

test("wrong driver, wrong job, future, invalid, blank and truck-only points cannot supply destination evidence", () => rollback.run(async () => {
  const f = await fixture();
  await f.verify({ login: "another-driver" });
  await f.verify({ jobId: "different-job" });
  await f.verify({ checkedAt: "2026-09-15T11:00:00.000Z" });
  for (const details of [
    { ...expected, expectedLatitude: 91 }, { ...expected, expectedLongitude: " " },
    { ...expected, expectedAddress: "999 Different Road" },
    { currentLatitude: 43.8, currentLongitude: -79.3, expectedAddress: address }
  ]) {await f.verify({ details });}
  const run = await f.preview({ automatic: true });
  assert.equal(run.results[0].error, "destination_coordinates_unavailable");
  assert.equal(calls.length, 0);
  assert.match(run.error, /destination coordinates/i);
  assert.doesNotMatch(run.error, /Samsara did not produce/i);
}));

test("same-site sequence works without coordinates and makes no GPS call", () => rollback.run(async () => {
  const f = await fixture({ sameSite: true });
  const run = await f.preview();
  assert.equal(run.results[1].resolutionStatus, "same_site");
  assert.equal(run.results[1].proposedArrivalAt, leave);
  assert.equal(calls.length, 0);
}));

test("unresolved arrival is exposed to forecast without substituting job start; completion remains visible", () => rollback.run(async () => {
  const f = await fixture();
  await f.preview({ automatic: true });
  const rows = (await listDriverJobStatuses({ planDate: "2026-09-14" })).filter(row => row.driver_login === f.driver);
  assert.equal(rows.find(row => row.stop_id === "D1").actual_arrival_resolution_status, "unresolved");
  const forecast = buildDispatchForecast(f.plan, rows);
  const stop = forecast.stops.find(row => row.stopId === "D1");
  assert.equal(stop.actualArrival, null);
  assert.equal(stop.actualArrivalSource, "unresolved");
  assert.equal(stop.actualArrivalReason, "destination_coordinates_unavailable");
  assert.equal(stop.actualLeave, complete);
  assert.equal(forecast.travelLegs.find(row => row.kind === "inter_stop").actualArrival, null);
}));

test("database microsecond completion precision still matches the retained unresolved calculation", () => rollback.run(async () => {
  const f = await fixture();
  await query("UPDATE driver_job_records SET completed_at='2026-09-14T11:28:49.000321Z' WHERE id=$1", [f.ids[1].id]);
  await f.preview({ automatic: true });
  const rows = (await listDriverJobStatuses({ planDate: "2026-09-14" })).filter(row => row.driver_login === f.driver);
  assert.equal(rows.find(row => row.stop_id === "D1").actual_arrival_resolution_status, "unresolved");
  assert.equal(buildDispatchForecast(f.plan, rows).stops.find(row => row.stopId === "D1").actualArrival, null);
  await query("UPDATE driver_job_records SET completed_at='2026-09-14T11:28:49.001321Z' WHERE id=$1", [f.ids[1].id]);
  const changed = (await listDriverJobStatuses({ planDate: "2026-09-14" })).filter(row => row.driver_login === f.driver);
  assert.equal(changed.find(row => row.stop_id === "D1").actual_arrival_resolution_status, null);
}));

test("a GPS cluster crossing the first 30-minute window retrieves its earlier arrival", () => rollback.run(async () => {
  const f = await fixture();
  await f.verify();
  gps = Array.from({ length: 34 }, (_, n) => sample(new Date(Date.parse("2026-09-14T10:55:00.000Z") + n * 60000).toISOString()));
  const run = await f.preview();
  assert.equal(run.results[1].proposedArrivalAt, "2026-09-14T10:55:00.000Z");
  assert.equal(calls.filter(url => url.pathname.endsWith("/stats/history")).length, 2);
}));

test("empty GPS keeps a previous valid arrival and reports the real unresolved reason", () => rollback.run(async () => {
  const f = await fixture();
  await f.verify();
  const first = await f.preview();
  await applyActualArrivalRun(first.runId, { expectedResultVersion: first.resultVersion, appliedBy: "test:repair" });
  gps = [];
  const second = await f.preview();
  assert.equal(second.results[1].error, "no_gps_points");
  await applyActualArrivalRun(second.runId, { expectedResultVersion: second.resultVersion, appliedBy: "test:repair" });
  const rows = await listDriverJobStatuses({ planDate: "2026-09-14" });
  const forecast = buildDispatchForecast(f.plan, rows);
  assert.equal(forecast.stops.find(row => row.stopId === "D1").actualArrival, "2026-09-14T11:15:00.000Z");
}));

test("failed earlier-window lookup never applies an arrival clipped to the first window", () => rollback.run(async () => {
  const f = await fixture();
  await f.verify();
  gps = Array.from({ length: 34 }, (_, n) => sample(new Date(Date.parse("2026-09-14T10:55:00.000Z") + n * 60000).toISOString()));
  historyFailureBefore = "2026-09-14T10:58:49.000Z";
  const run = await f.preview();
  assert.equal(run.results[1].resolutionStatus, "unresolved");
  assert.equal(run.results[1].error, "gps_history_incomplete");
  assert.equal(run.results[1].proposedArrivalAt, null);
}));

test("incomplete paginated earlier history cannot establish a clipped arrival", () => rollback.run(async () => {
  const f = await fixture();
  await f.verify();
  gps = Array.from({ length: 34 }, (_, n) => sample(new Date(Date.parse("2026-09-14T10:55:00.000Z") + n * 60000).toISOString()));
  truncatedHistory = true;
  try {
    const run = await f.preview();
    assert.equal(run.results[1].error, "gps_history_incomplete");
    assert.equal(run.results[1].proposedArrivalAt, null);
  } finally { Date.now = originalNow; }
}));

test("locally retained GPS resolves with verification provenance and no remote request", () => rollback.run(async () => {
  const f = await fixture();
  await f.verify();
  for (const point of gps) {
    await query(`INSERT INTO dispatch_truck_location_history(plate,latitude,longitude,speed_miles_per_hour,location_time)
      VALUES ('ARRIVAL-TEST',$1,$2,0,$3)`, [point.latitude, point.longitude, point.time]);
  }
  const run = await f.preview();
  assert.equal(run.results[1].proposedArrivalAt, "2026-09-14T11:15:00.000Z");
  assert.equal(run.results[1].evidence.destinationSource, "driver_location_verification");
  assert.ok(run.results[1].evidence.destinationVerificationId);
  assert.equal(calls.length, 0);
}));
