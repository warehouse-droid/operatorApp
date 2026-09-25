import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { backfillHistoricalArrivals, historicalArrivalInventory } from "../../../tools/actual-arrival-backfill.mjs";

after(closeDb);
async function scenario(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arrival-backfill-test-"));
  try {
    await withTransaction(async () => {
      const drivers = [];
      for (const [date, sameSite] of [["2026-07-07", true], ["2026-09-19", false]]) {
        const driver = `backfill-${crypto.randomUUID()}`;
        drivers.push(driver);
        for (const [index, type, address, start, end] of [
          [1, "pickup", "100 Recorded Site", "10:00", "10:30"],
          [2, "dropoff", sameSite ? "100 Recorded Site" : "200 Missing Coordinates", "10:30", "11:00"]
        ]) {
          const job = `${driver}-${index}`;
          await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,truck_plate,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at,job_details)
            VALUES($1,$2,$3,'TEST-TRUCK',$3,$1,$4,'["TEST"]','complete',$5,$6,$7)`,
          [job, date, driver, type, `${date}T${start}:00Z`, `${date}T${end}:00Z`, JSON.stringify({ address, physicalVisitJobIds: [job] })]);
        }
      }
      const settings = async () => ({ ownYards: [], samsara: { actualStopArrivalEnabled: true } });
      await body({ outputPath: path.join(dir, "report.json"), cutoffDate: "2026-09-19", settings, drivers });
    }, { rollback: true });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("backfill attempts the earliest and latest history, preserves evidence, records unresolved stops, and resumes without duplicate apply", () => scenario(async options => {
  const inventory = await historicalArrivalInventory(options.cutoffDate);
  assert.equal(inventory.length, 2);
  assert.equal(inventory[0].planDate, "2026-07-07");
  const first = await backfillHistoricalArrivals(options);
  assert.deepEqual(first.summary, { appliedRoutes: 2, failedRoutes: 0, resolvedVisits: 1, unresolvedVisits: 1, unchangedFirstVisits: 2 });
  assert.equal(first.originalDriverEvidenceUnchanged, true);
  assert.equal(Object.values(first.results).flatMap(entry => entry.unresolvedStops).at(0).reason, "destination_coordinates_unavailable");
  const appliedIds = Object.values(first.results).map(entry => entry.runId);
  const canonical = (await query("SELECT * FROM dispatch_actual_stop_arrivals ORDER BY driver_job_record_id")).rows;
  const second = await backfillHistoricalArrivals(options);
  assert.deepEqual(Object.values(second.results).map(entry => entry.runId), appliedIds);
  assert.deepEqual((await query("SELECT * FROM dispatch_actual_stop_arrivals ORDER BY driver_job_record_id")).rows, canonical);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_audit_log WHERE action='dispatch_actual_arrival_history_repair_applied'")).rows[0].n, 2);
}));

test("an interruption after one saved route resumes the remaining route", () => scenario(async options => {
  await assert.rejects(backfillHistoricalArrivals({ ...options, progress: () => { throw new Error("simulated interruption"); } }), /simulated interruption/);
  const interrupted = JSON.parse(await fs.readFile(options.outputPath, "utf8"));
  assert.equal(Object.keys(interrupted.results).length, 1);
  const firstId = Object.values(interrupted.results)[0].runId;
  const finished = await backfillHistoricalArrivals(options);
  assert.equal(finished.summary.appliedRoutes, 2);
  assert.equal(Object.values(finished.results)[0].runId, firstId);
  assert.equal(finished.originalDriverEvidenceUnchanged, true);
}));

test("disabled calculation records route failures, and a resumed enabled run recovers them", () => scenario(async options => {
  const disabled = await backfillHistoricalArrivals({ ...options, settings: async () => ({ samsara: { actualStopArrivalEnabled: false } }) });
  assert.equal(disabled.summary.failedRoutes, 2);
  assert.equal(disabled.summary.appliedRoutes, 0);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_actual_stop_arrivals")).rows[0].n, 0);
  const enabled = await backfillHistoricalArrivals(options);
  assert.equal(enabled.summary.failedRoutes, 0);
  assert.equal(enabled.summary.appliedRoutes, 2);
}));

test("a saved ledger catches up after apply committed before its final checkpoint", () => scenario(async options => {
  const report = await backfillHistoricalArrivals(options);
  const entry = Object.values(report.results)[0];
  const runId = entry.runId;
  entry.status = "running";
  await fs.writeFile(options.outputPath, JSON.stringify(report));
  const resumed = await backfillHistoricalArrivals(options);
  assert.equal(resumed.summary.appliedRoutes, 2);
  assert.equal(Object.values(resumed.results)[0].runId, runId);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_audit_log WHERE entity_id=$1", [runId])).rows[0].n, 1);
}));

test("an active repair lease is respected and only its expired lease can be recovered", () => scenario(async options => {
  const report = await backfillHistoricalArrivals({ ...options, settings: async () => ({ samsara: { actualStopArrivalEnabled: false } }) });
  const entry = Object.values(report.results)[0];
  await query("UPDATE dispatch_actual_arrival_runs SET status='running',lease_owner='system:actual-arrival-history-repair-v2',lease_expires_at=now()+interval '15 minutes' WHERE run_id=$1", [entry.runId]);
  const active = await backfillHistoricalArrivals(options);
  assert.equal(active.summary.failedRoutes, 1);
  assert.match(Object.values(active.results)[0].error, /lease remains active/);
  await query("UPDATE dispatch_actual_arrival_runs SET lease_expires_at=now()-interval '1 minute' WHERE run_id=$1", [entry.runId]);
  const recovered = await backfillHistoricalArrivals(options);
  assert.equal(recovered.summary.failedRoutes, 0);
  assert.equal(recovered.summary.appliedRoutes, 2);
  assert.notEqual(Object.values(recovered.results)[0].runId, entry.runId);
}));

test("real CLI inventories, applies and resumes an isolated historical route", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arrival-cli-"));
  const driver = `arrival-cli-${crypto.randomUUID()}`;
  try {
    await fs.cp("src", path.join(root, "src"), { recursive: true });
    await fs.symlink(path.resolve("public"), path.join(root, "public"));
    await fs.mkdir(path.join(root, "tools"));
    await fs.mkdir(path.join(root, "data"));
    await fs.copyFile("tools/actual-arrival-backfill.mjs", path.join(root, "tools/actual-arrival-backfill.mjs"));
    await fs.copyFile("package.json", path.join(root, "package.json"));
    await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"));
    const setup = path.join(root, "data/dispatch-setup.json");
    await fs.writeFile(setup, JSON.stringify({ samsara: { actualStopArrivalEnabled: false } }));
    for (const [index, type, start, end] of [[1, "pickup", "10:00", "10:30"], [2, "dropoff", "10:30", "11:00"]]) {
      const job = `${driver}-${index}`;
      await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,truck_plate,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at,job_details)
        VALUES($1,'2000-01-01',$2,'TEST-TRUCK',$2,$1,$3,'["TEST"]','complete',$4,$5,$6)`,
      [job, driver, type, `2000-01-01T${start}:00Z`, `2000-01-01T${end}:00Z`, JSON.stringify({ address: "100 CLI Test Site", physicalVisitJobIds: [job] })]);
    }
    const outputPath = path.join(root, "report.json");
    const run = (...args) => spawnSync(process.execPath, [path.join(root, "tools/actual-arrival-backfill.mjs"), "--cutoff=2000-01-01", ...args], {
      encoding: "utf8", env: { ...process.env, ARRIVAL_BACKFILL_OUTPUT: outputPath }, timeout: 30000
    });
    const inventory = run();
    assert.equal(inventory.status, 0, inventory.stderr);
    assert.equal(JSON.parse(inventory.stdout).records, 2);
    const disabled = run("--apply");
    assert.equal(disabled.status, 1, disabled.stderr);
    await fs.writeFile(setup, JSON.stringify({ samsara: { actualStopArrivalEnabled: true } }));
    const applied = run("--apply");
    assert.equal(applied.status, 0, applied.stderr);
    const report = JSON.parse(await fs.readFile(outputPath, "utf8"));
    assert.equal(report.summary.appliedRoutes, 1);
    assert.equal(report.summary.resolvedVisits, 1);
    assert.equal(report.originalDriverEvidenceUnchanged, true);
    assert.equal(run("--apply").status, 0);
  } finally {
    await query("DELETE FROM dispatch_actual_stop_arrivals WHERE driver_job_record_id IN (SELECT id FROM driver_job_records WHERE driver_login=$1)", [driver]);
    await query("DELETE FROM dispatch_audit_log WHERE entity_id IN (SELECT run_id::text FROM dispatch_actual_arrival_runs WHERE driver_login=$1)", [driver]);
    await query("DELETE FROM dispatch_actual_arrival_runs WHERE driver_login=$1", [driver]);
    await query("DELETE FROM driver_job_records WHERE driver_login=$1", [driver]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
