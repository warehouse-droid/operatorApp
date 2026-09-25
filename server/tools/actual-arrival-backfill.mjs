import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query, withTransaction, closeDb } from "../src/db.js";
import { DISPATCH_ACTUAL_ARRIVAL_ALGORITHM_VERSION } from "../src/dispatch-actual-arrival-policy.js";
import { executeActualArrivalRun } from "../src/dispatch-actual-arrival-service.js";
import { applyActualArrivalRun, createHistoricalActualArrivalRun, getActualArrivalRun, markActualArrivalRun } from "../src/dispatch-actual-arrival-repository.js";
import { writeDispatchAudit } from "../src/dispatch-audit-repository.js";

const ACTOR = "system:actual-arrival-history-repair-v2";
const key = route => `${route.planDate}|${route.driverLogin}`;
async function saveJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function historicalArrivalInventory(cutoffDate) {
  assert.match(cutoffDate, /^\d{4}-\d{2}-\d{2}$/u);
  const result = await query(`SELECT plan_date::text AS "planDate",lower(btrim(driver_login)) AS "driverLogin",
      count(*)::int AS "recordCount",array_agg(id ORDER BY id)::text[] AS "recordIds"
    FROM driver_job_records
    WHERE status='complete' AND lower(stop_type) IN ('pickup','dropoff')
      AND completed_at IS NOT NULL AND plan_date <= $1::date AND btrim(driver_login)<>''
    GROUP BY plan_date,lower(btrim(driver_login)) ORDER BY plan_date,lower(btrim(driver_login))`, [cutoffDate]);
  return result.rows;
}

async function evidenceFingerprints(ids) {
  const result = await query(`SELECT id::text,md5(to_jsonb(record)::text) AS fingerprint
    FROM driver_job_records record WHERE id=ANY($1::bigint[]) ORDER BY id`, [ids]);
  return result.rows;
}

async function claimHistoricalRoute(route) {
  return withTransaction(async () => {
    const run = await createHistoricalActualArrivalRun({ ...route, requestedBy: ACTOR });
    const token = crypto.randomUUID();
    const claimed = await query(`UPDATE dispatch_actual_arrival_runs SET status='running',attempt_count=attempt_count+1,
      started_at=coalesce(started_at,now()),lease_token=$2,lease_owner=$3,lease_expires_at=now()+interval '15 minutes'
      WHERE run_id=$1 AND status='queued' AND requested_by=$3 RETURNING run_id`, [run.runId, token, ACTOR]);
    if (!claimed.rowCount) {throw new Error("Another calculation already owns this historical driver-day; retry after it completes.");}
    return { run: { ...run, status: "running", attemptCount: run.attemptCount + 1 }, token };
  });
}

async function applyRoute(route, entry, persist, settings) {
  let run = entry.runId ? await getActualArrivalRun(entry.runId) : null;
  if (run?.status === "applied") {return run;}
  if (run?.status !== "preview_ready") {
    if (run?.status === "running") {
      const lease = (await query("SELECT lease_expires_at,lease_owner FROM dispatch_actual_arrival_runs WHERE run_id=$1", [run.runId])).rows[0];
      if (lease?.lease_owner !== ACTOR || new Date(lease.lease_expires_at).getTime() > Date.now()) {
        throw new Error("A prior worker lease remains active; resume after its expiry.");
      }
      await markActualArrivalRun(run.runId, "failed", { error: "Expired historical repair lease; recalculating from current evidence." });
    }
    const claimed = await claimHistoricalRoute(route);
    run = claimed.run;
    entry.runId = run.runId;
    entry.status = "running";
    await persist();
    const heartbeat = setInterval(() => {
      void query("UPDATE dispatch_actual_arrival_runs SET lease_expires_at=now()+interval '15 minutes' WHERE run_id=$1 AND lease_token=$2 AND status='running'", [run.runId, claimed.token]).catch(() => {});
    }, 30000);
    heartbeat.unref();
    try {
      const setup = await settings();
      if (setup.samsara?.actualStopArrivalEnabled !== true) {throw new Error("Actual arrival calculation is disabled.");}
      await executeActualArrivalRun(run, { ownYards: setup.ownYards || [], isGateEnabled: async () => (await settings()).samsara?.actualStopArrivalEnabled === true });
      run = await getActualArrivalRun(run.runId);
    } catch (error) {
      await markActualArrivalRun(run.runId, "failed", { error: error.message });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
  assert.equal(run.status, "preview_ready", `Historical calculation ${run.runId} is ${run.status}`);
  if ((await settings()).samsara?.actualStopArrivalEnabled !== true) {throw new Error("Actual arrival calculation was disabled before apply.");}
  return withTransaction(async () => {
    const applied = await applyActualArrivalRun(run.runId, { expectedResultVersion: run.resultVersion, appliedBy: ACTOR });
    await writeDispatchAudit({ action: "dispatch_actual_arrival_history_repair_applied", entityType: "actual_arrival_run", entityId: run.runId,
      planDate: route.planDate, operatorName: ACTOR, source: "actual-arrival-history-repair",
      after: { status: applied.status, resolvedStops: applied.resolvedStops, unresolvedStops: applied.unresolvedStops, skippedStops: applied.skippedStops },
      details: { driverLogin: route.driverLogin, algorithmVersion: DISPATCH_ACTUAL_ARRIVAL_ALGORITHM_VERSION } });
    return applied;
  });
}

export async function backfillHistoricalArrivals({ cutoffDate, outputPath, settings, progress = () => {} }) {
  const routes = await historicalArrivalInventory(cutoffDate);
  const ids = routes.flatMap(route => route.recordIds);
  let report;
  try { report = JSON.parse(await fs.readFile(outputPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") {throw error;} }
  if (!report) {
    const prior = await query("SELECT * FROM dispatch_actual_stop_arrivals WHERE driver_job_record_id=ANY($1::bigint[]) ORDER BY driver_job_record_id", [ids]);
    report = { startedAt: new Date().toISOString(), cutoffDate, algorithmVersion: DISPATCH_ACTUAL_ARRIVAL_ALGORITHM_VERSION,
      routes, before: await evidenceFingerprints(ids), priorArrivals: prior.rows, results: {} };
    await saveJson(outputPath, report);
  }
  assert.equal(report.cutoffDate, cutoffDate);
  assert.equal(report.algorithmVersion, DISPATCH_ACTUAL_ARRIVAL_ALGORITHM_VERSION);
  assert.deepEqual(report.routes, routes, "Historical route inventory changed; review the captured cutoff before resuming.");
  const persist = () => saveJson(outputPath, report);
  for (const route of routes) {
    const entry = report.results[key(route)] ||= { status: "pending" };
    if (entry.status === "applied") {continue;}
    try {
      const applied = await applyRoute(route, entry, persist, settings);
      Object.assign(entry, { status: applied.status, runId: applied.runId, resolved: applied.resolvedStops,
        unresolved: applied.unresolvedStops, skipped: applied.skippedStops, error: "",
        unresolvedStops: applied.results.filter(result => result.resolutionStatus === "unresolved").map(result => ({
          orders: result.orderRefs, load: result.loadName, stopIds: result.stopIds, recordIds: result.driverJobRecordIds, reason: result.error
        })) });
    } catch (error) {
      entry.status = "failed";
      entry.error = String(error.message);
    }
    entry.updatedAt = new Date().toISOString();
    await persist();
    progress({ route: key(route), ...entry, unresolvedStops: undefined });
  }
  report.after = await evidenceFingerprints(ids);
  report.originalDriverEvidenceUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
  report.summary = Object.values(report.results).reduce((totals, entry) => ({
    appliedRoutes: totals.appliedRoutes + (entry.status === "applied" ? 1 : 0),
    failedRoutes: totals.failedRoutes + (entry.status === "failed" ? 1 : 0),
    resolvedVisits: totals.resolvedVisits + (entry.resolved || 0), unresolvedVisits: totals.unresolvedVisits + (entry.unresolved || 0),
    unchangedFirstVisits: totals.unchangedFirstVisits + (entry.skipped || 0)
  }), { appliedRoutes: 0, failedRoutes: 0, resolvedVisits: 0, unresolvedVisits: 0, unchangedFirstVisits: 0 });
  report.finishedAt = new Date().toISOString();
  await persist();
  assert.equal(report.originalDriverEvidenceUnchanged, true, "Original driver evidence changed during the historical repair; inspect the before/after fingerprints.");
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cutoffDate = process.argv.find(arg => arg.startsWith("--cutoff="))?.slice(9);
  assert.ok(cutoffDate, "Provide --cutoff=YYYY-MM-DD and --apply for historical recalculation.");
  let lock;
  try {
    if (!process.argv.includes("--apply")) {
      const routes = await historicalArrivalInventory(cutoffDate);
      console.log(JSON.stringify({ cutoffDate, driverDays: routes.length, records: routes.reduce((sum, route) => sum + route.recordCount, 0), firstDate: routes[0]?.planDate }));
    } else {
      lock = await pool.connect();
      const held = await lock.query("SELECT pg_try_advisory_lock(73499201) AS locked");
      assert.equal(held.rows[0].locked, true, "A historical arrival repair is already running.");
      const report = await backfillHistoricalArrivals({ cutoffDate,
        outputPath: process.env.ARRIVAL_BACKFILL_OUTPUT || `/app/data/actual-arrival-history-repair-${cutoffDate}.json`,
        settings: async () => JSON.parse(await fs.readFile(new URL("../data/dispatch-setup.json", import.meta.url), "utf8")),
        progress: row => console.log(JSON.stringify(row)) });
      console.log(JSON.stringify({ ...report.summary, originalDriverEvidenceUnchanged: report.originalDriverEvidenceUnchanged }));
      if (report.summary.failedRoutes) {process.exitCode = 1;}
    }
  } finally {
    if (lock) { await lock.query("SELECT pg_advisory_unlock(73499201)"); lock.release(); }
    await closeDb();
  }
}
