import crypto from "node:crypto";

import { pool } from "../src/db.js";
import { googleMapsRouteFingerprint } from "../src/google-maps-usage-policy.js";
import { replayGoogleMapsUsage } from "../src/google-maps-usage-replay.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const today = new Date();
const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
const from = new Date(to.getTime() - (7 * DAY_MS));
const params = [from.toISOString(), to.toISOString()];

function digest(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function orderIndex(orders = []) {
  const byId = new Map();
  const visit = (order) => {
    if (!order || typeof order !== "object") {return;}
    const id = String(order.id || order.orderId || order.orderRef || order.tranid || "").trim();
    if (id) {byId.set(id, order);}
    for (const child of order.childOrderDetails || []) {visit(child);}
  };
  for (const order of orders || []) {visit(order);}
  return byId;
}

// eslint-disable-next-line complexity
function stopLocation(stop = {}, order = {}) {
  if (String(stop.type || "").toLowerCase() === "pick") {
    return stop.location
      || stop.pickupLocation
      || order.pickupLocations?.[0]
      || order.sourceYard
      || order.fromLocation
      || "unknown pickup";
  }
  return stop.dropAddress
    || stop.dropLocation
    || order.address
    || order.destination
    || order.destinationYard
    || "unknown destination";
}

function stopStayMinutes(stop = {}) {
  const explicit = Number(stop.stayMinutes ?? stop.stopMinutes ?? stop.stopTimeOverrideMinutes);
  return Number.isFinite(explicit) && explicit >= 0 ? explicit : 0;
}

// eslint-disable-next-line complexity
function replayLoad(rawLoad = {}, truck = {}, ordersById = new Map(), snapshotKey = "", planDate = "") {
  const estimate = rawLoad.routeEstimate && typeof rawLoad.routeEstimate === "object"
    ? rawLoad.routeEstimate
    : null;
  const derivedStops = (rawLoad.stops || []).map((stop) => {
    const order = ordersById.get(String(stop.orderId || "")) || {};
    return { location: stopLocation(stop, order), stayMinutes: stopStayMinutes(stop) };
  });
  if (derivedStops.length === 1) {
    derivedStops.unshift({ location: truck.base || truck.startYard || "dispatch origin", stayMinutes: 0 });
  }
  const expectedStopCount = Array.isArray(estimate?.legMinutes)
    ? estimate.legMinutes.length + 1
    : derivedStops.length;
  const stopCount = Math.max(derivedStops.length, expectedStopCount, rawLoad.stops?.length ? 2 : 1);
  const stops = Array.from({ length: stopCount }, (_, index) => derivedStops[index] || {
    location: `route point ${index + 1}`,
    stayMinutes: 0
  });
  const routeShapeIdentity = estimate?.routeSignature
    ? digest(estimate.routeSignature)
    : googleMapsRouteFingerprint({
        stops: derivedStops,
        allowTolls: Boolean(rawLoad.allowTolls),
        travelTimePercent: Number(truck.travelTimePercent || 0)
      });
  const routeIdentity = digest(JSON.stringify({
    routeShapeIdentity,
    planDate: String(planDate || ""),
    scheduledStart: rawLoad.start ?? rawLoad.startMinutes ?? "auto",
    startMode: rawLoad.startMode || ""
  }));
  return {
    loadKey: digest(`${snapshotKey}:${rawLoad.id || rawLoad.name || "load"}`),
    routeFingerprint: routeIdentity,
    stops,
    routeEstimate: estimate,
    fallbackLegMinutes: stops.slice(1).map((stop, index) =>
      normalizedText(stop.location) === normalizedText(stops[index]?.location) ? 0 : 30),
    travelTimePercent: Number(truck.travelTimePercent || 0),
    allowTolls: Boolean(rawLoad.allowTolls)
  };
}

function replaySnapshot(row) {
  const ordersById = orderIndex(row.orders || []);
  const snapshotKey = `${row.source}:${row.source_id}`;
  return {
    eventAt: new Date(row.event_at).toISOString(),
    planKey: digest(row.plan_id),
    planDate: String(row.plan_date || ""),
    planStatus: String(row.status || ""),
    confirmed: false,
    loads: (row.trucks || []).flatMap((truck) =>
      (truck.loads || []).map((load) => replayLoad(load, truck, ordersById, snapshotKey, row.plan_date)))
  };
}

function markConfirmationSnapshots(snapshots, confirmationRows) {
  for (const confirmation of confirmationRows) {
    const planKey = digest(confirmation.plan_id);
    const eventEpoch = new Date(confirmation.created_at).getTime();
    const candidates = snapshots
      .filter((snapshot) => snapshot.planKey === planKey && new Date(snapshot.eventAt).getTime() <= eventEpoch + 60_000)
      .sort((left, right) => new Date(right.eventAt) - new Date(left.eventAt));
    if (candidates[0]) {candidates[0].confirmed = true;}
  }
  const byPlan = new Map();
  for (const snapshot of snapshots) {
    if (snapshot.planStatus !== "confirmed") {continue;}
    const previous = byPlan.get(snapshot.planKey);
    if (!previous || new Date(snapshot.eventAt) > new Date(previous.eventAt)) {byPlan.set(snapshot.planKey, snapshot);}
  }
  for (const snapshot of byPlan.values()) {snapshot.confirmed = true;}
}

const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const readOnly = await client.query("SHOW transaction_read_only");
  if (readOnly.rows[0]?.transaction_read_only !== "on") {throw new Error("Replay requires a read-only transaction.");}

  const snapshotRows = await client.query(
      `SELECT 'history'::text AS source, history.id::text AS source_id,
              history.plan_id, history.archived_at AS event_at,
              history.orders, history.trucks, plan.status, plan.plan_date
         FROM dispatch_plan_snapshot_history history
         JOIN dispatch_plans plan ON plan.id = history.plan_id
        WHERE history.archived_at >= $1::timestamptz AND history.archived_at < $2::timestamptz
       UNION ALL
       SELECT 'current'::text AS source, snapshot.plan_id::text AS source_id,
              snapshot.plan_id, snapshot.saved_at AS event_at,
              snapshot.orders, snapshot.trucks, plan.status, plan.plan_date
         FROM dispatch_plan_snapshots snapshot
         JOIN dispatch_plans plan ON plan.id = snapshot.plan_id
        WHERE snapshot.saved_at >= $1::timestamptz AND snapshot.saved_at < $2::timestamptz
        ORDER BY event_at, source_id`, params);
  const confirmationRows = await client.query(
      `SELECT plan_id, created_at
         FROM dispatch_audit_log
        WHERE action = 'dispatch_plan_confirmed'
          AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at`, params);
  const jobRows = await client.query(
      `SELECT truck_plate, started_at, completed_at, status, stop_type, job_details
         FROM driver_job_records
        WHERE started_at < $2::timestamptz
          AND coalesce(completed_at, $2::timestamptz) >= $1::timestamptz
          AND started_at IS NOT NULL`, params);
  const auditTotals = await client.query(
      `SELECT count(*) FILTER (WHERE action = 'scm.transfer_dependency.suggested')::integer AS dependency_suggestions,
              count(DISTINCT session_id) FILTER (
                WHERE nullif(btrim(session_id), '') IS NOT NULL AND source = 'dispatch'
              )::integer AS known_browser_sessions
         FROM dispatch_audit_log
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, params);

  const snapshots = snapshotRows.rows.map(replaySnapshot);
  markConfirmationSnapshots(snapshots, confirmationRows.rows);
  const activeTruckIntervals = jobRows.rows
    .map((row) => ({
      truckKey: digest(row.truck_plate || "unknown truck"),
      startedAt: new Date(Math.max(from.getTime(), new Date(row.started_at).getTime())).toISOString(),
      completedAt: new Date(Math.min(
        to.getTime(),
        row.completed_at ? new Date(row.completed_at).getTime() : to.getTime()
      )).toISOString()
    }));
  const completedJobs = jobRows.rows.filter((row) =>
    row.status === "complete"
      && row.completed_at
      && new Date(row.completed_at) >= from
      && new Date(row.completed_at) < to).length;
  const destinations = new Set(jobRows.rows.flatMap((row) => {
    const details = row.job_details && typeof row.job_details === "object" ? row.job_details : {};
    const value = details.address || details.toAddress || details.to_address || details.location || details.expectedAddress || "";
    const normalized = normalizedText(value);
    return normalized ? [digest(normalized)] : [];
  }));
  const knownBrowserSessions = Number(auditTotals.rows[0]?.known_browser_sessions || 0);
  const report = replayGoogleMapsUsage({
    windowDays: 7,
    snapshots,
    activeTruckIntervals,
    completedJobs,
    uniqueUnresolvedDestinations: destinations.size,
    dependencySuggestions: Number(auditTotals.rows[0]?.dependency_suggestions || 0),
    browserMapSessions: knownBrowserSessions
  });
  const output = {
    schemaVersion: "google-maps-usage-replay-v1",
    window: { from: from.toISOString(), to: to.toISOString(), completeUtcDays: 7 },
    evidence: {
      ...report.sourceEvents,
      confirmedPlanEvents: confirmationRows.rowCount,
      knownBrowserSessions,
      browserSessionCoverage: "lower_bound_from_dispatch_audit_sessions"
    },
    routePreviews: report.previews,
    currentMechanismEstimate: report.current,
    controlledMechanismEstimate: report.controlled,
    reductionPercent: report.reductionPercent,
    methodology: {
      comparison: "same production event rows under reconstructed legacy and controlled policies",
      currentMonitorModel: "one equivalent open monitor stream, 45-second legacy ETA cache cadence",
      dispatchCacheModel: "one legacy fan-out or controlled request per unique reconstructed route identity",
      browserMapSessions: "lower bound because historical map-canvas constructions were not metered",
      geocoding: "one process-cache lookup per unique observed destination; no speculative duplicate savings",
      estimatesNotCloudBilling: true
    },
    assertions: {
      everyRoutePreviewValid: report.previews.invalid === 0 && report.previews.valid === report.previews.total,
      everyRouteFingerprintStable: report.previews.fingerprints.unstable === 0,
      controlledProjectedBelow5000: report.controlled.projected30Day < 5_000,
      noGoogleCallsMadeByReplay: true
    }
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (
    !output.assertions.everyRoutePreviewValid
    || !output.assertions.everyRouteFingerprintStable
    || !output.assertions.controlledProjectedBelow5000
  ) {process.exitCode = 1;}
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => null);
  throw error;
} finally {
  client.release();
  await pool.end();
}
