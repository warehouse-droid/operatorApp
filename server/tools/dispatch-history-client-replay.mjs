// Load every retained Dispatch plan state into the planner page twice, once with
// the baseline public/ tree and once with the candidate tree, and compare the
// per-load timing the browser derives (estimate use, start, finish).
// Usage: node tools/dispatch-history-client-replay.mjs <baseline-public-dir> <candidate-public-dir> <output-dir>
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";
import pg from "pg";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, routeEstimates, loadStats, estimateForLoad,
isMbtPlanningLoad, mapStopsForLoad, routeSignature */

const [baselineDir, candidateDir, outputDir] = process.argv.slice(2);
const from = process.env.DISPATCH_HISTORY_FROM || "2026-08-01";
const through = process.env.DISPATCH_HISTORY_THROUGH || "2999-12-31";
if (process.env.MBT_TEST_ISOLATED !== "1") throw new Error("Client history replay requires MBT_TEST_ISOLATED=1.");

function serve(publicDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".js")) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(await readFile(path.join(publicDir, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/u, ""))));
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>');
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function evaluateState(state) {
  try {
    dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false,
      driverOrientedPlanning: true };
    dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready";
    currentPlanDate = state.planDate;
    currentPlan = compactCurrentPlan({ id: state.planId, planDate: state.planDate, revision: 1, digest: "replay",
      status: "draft" });
    orders = (state.orders || []).map(normalizeOrder);
    orderCatalog = structuredClone(orders);
    trucks = structuredClone(state.trucks || []);
    fleet = structuredClone(trucks);
    routeEstimates = {};
    const loads = [];
    for (const truck of trucks) {
      for (const load of truck.loads || []) {
        if (isMbtPlanningLoad(load)) continue;
        const stats = loadStats(truck, load);
        const entry = { id: String(load.id || ""), estimate: Boolean(estimateForLoad(load)),
          savedEstimate: Boolean(load.routeEstimate), start: Math.round(stats.start), finish: Math.round(stats.finish) };
        if (load.routeEstimate?.routeSignature) {
          // Where a saved estimate's stop signature first departs from the current stops.
          const stops = mapStopsForLoad(load, truck);
          const stored = String(load.routeEstimate.routeSignature);
          const storedStops = stored.slice(stored.indexOf("@") + 1, stored.lastIndexOf("@start:")).split(">");
          const currentStops = routeSignature(stops).split(">");
          const index = currentStops.findIndex((value, position) => value !== storedStops[position]);
          entry.diag = { legs: (load.routeEstimate.legMinutes || []).length, stops: stops.length,
            storedStops: storedStops.length, firstDiff: index < 0 && storedStops.length === currentStops.length ? null
              : { index, stored: storedStops[index] ?? null, current: currentStops[index] ?? null } };
        }
        loads.push(entry);
      }
    }
    return { ok: true, loads };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300) };
  }
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const states = (await client.query(`SELECT * FROM (
    SELECT 'snapshot' AS stream, s.plan_id::text AS source_id, s.plan_id::text AS plan_id, p.plan_date::text AS plan_date,
           s.orders, s.trucks FROM dispatch_plan_snapshots s JOIN dispatch_plans p ON p.id = s.plan_id
    UNION ALL
    SELECT 'history', h.id::text, h.plan_id::text, p.plan_date::text, h.orders, h.trucks
      FROM dispatch_plan_snapshot_history h JOIN dispatch_plans p ON p.id = h.plan_id
     WHERE NOT (h.archive_reason = 'save_recovery' AND h.checkpoint_kind = 'recovery')
  ) states WHERE plan_date BETWEEN $1 AND $2 ORDER BY plan_date, stream, source_id`, [from, through])).rows;
await client.end();

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = {};
try {
  for (const [label, dir] of [["baseline", baselineDir], ["candidate", candidateDir]]) {
    const server = await serve(dir);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    results[label] = new Map();
    for (const state of states) {
      const key = `${state.stream}:${state.source_id}`;
      results[label].set(key, await page.evaluate(evaluateState, { planId: state.plan_id, planDate: state.plan_date,
        orders: state.orders, trucks: state.trucks }));
    }
    results[label].pageErrors = errors.slice(0, 20);
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  await browser.close();
}

const report = { from, through, states: states.length, newErrors: [], estimateDropped: [], knockOn: [], timingChanged: [],
  baselineErrors: 0, savedEstimateLoads: 0, pageErrors: { baseline: results.baseline.pageErrors,
    candidate: results.candidate.pageErrors } };
for (const state of states) {
  const key = `${state.stream}:${state.source_id}`;
  const before = results.baseline.get(key);
  const after = results.candidate.get(key);
  if (!before.ok) report.baselineErrors += 1;
  if (before.ok && !after.ok) report.newErrors.push({ key, planDate: state.plan_date, error: after.error });
  if (!before.ok || !after.ok) continue;
  const afterById = new Map(after.loads.map((load) => [load.id, load]));
  // A dropped stale estimate moves that load's finish, and later loads of the
  // same driver inherit their start from it.
  const dropped = before.loads.some((load) => load.estimate && !afterById.get(load.id)?.estimate);
  for (const load of before.loads) {
    const next = afterById.get(load.id);
    if (load.savedEstimate) report.savedEstimateLoads += 1;
    const change = { key, planDate: state.plan_date, load: load.id,
      start: [load.start, next.start], finish: [load.finish, next.finish] };
    if (load.estimate && !next.estimate) report.estimateDropped.push(change);
    else if (load.start !== next.start || load.finish !== next.finish) {
      (dropped ? report.knockOn : report.timingChanged).push(change);
    }
  }
}
await writeFile(path.join(outputDir, "client-compare.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ states: report.states, baselineErrors: report.baselineErrors,
  newErrors: report.newErrors.length, savedEstimateLoads: report.savedEstimateLoads,
  estimateDropped: report.estimateDropped.length, knockOn: report.knockOn.length,
  timingChanged: report.timingChanged.length,
  pageErrors: report.pageErrors }));
for (const row of [...report.newErrors, ...report.timingChanged].slice(0, 30)) console.log(JSON.stringify(row));
for (const row of report.estimateDropped.slice(0, 15)) console.log(JSON.stringify({ kind: "estimateDropped", ...row }));
const diagnostics = states.flatMap((state) => (results.candidate.get(`${state.stream}:${state.source_id}`).loads || [])
  .filter((load) => load.diag?.firstDiff).map((load) => ({ key: `${state.stream}:${state.source_id}`, load: load.id, ...load.diag })));
for (const row of diagnostics.slice(0, 12)) console.log(JSON.stringify({ kind: "signatureDiff", ...row }));
if (report.newErrors.length || report.timingChanged.length) process.exitCode = 1;
