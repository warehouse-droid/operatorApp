// Run read-only in the deployed application's /app working directory:
// docker exec -i mbbs-operator-app-app-1 node --input-type=module < this-file
import { query, closeDb } from "./src/db.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { getDispatchPlan } from "./src/dispatch-plan-repository.js";
import { listDriverJobStatuses } from "./src/driver-repository.js";
import { buildDispatchForecast } from "./src/dispatch-forecast-service.js";

try {
  const state = (await query(`SELECT json_build_object('capturedAt',now(),
    'plans',(SELECT json_agg(json_build_object('id',p.id,'hash',md5(to_jsonb(p)::text))) FROM dispatch_plans p WHERE p.plan_date<='2026-09-19'),
    'snapshots',(SELECT json_agg(json_build_object('planId',s.plan_id,'hash',md5(to_jsonb(s)::text))) FROM dispatch_plan_snapshots s JOIN dispatch_plans p ON p.id=s.plan_id WHERE p.plan_date<='2026-09-19'),
    'arrivals',(SELECT json_agg(json_build_object('recordId',r.id,'jobId',r.job_id,'date',r.plan_date,'driver',r.driver_login,'orders',r.order_refs,'type',r.stop_type,'startedAt',r.started_at,'completedAt',r.completed_at,'actualArrival',a.actual_arrival_at,'algorithmVersion',a.algorithm_version))
      FROM driver_job_records r LEFT JOIN dispatch_actual_stop_arrivals a ON a.driver_job_record_id=r.id
      WHERE r.status='complete' AND lower(r.stop_type) IN ('pickup','dropoff') AND r.completed_at IS NOT NULL AND r.plan_date<='2026-09-19')) AS state`)).rows[0].state;
  const examples = [];
  const ledger = JSON.parse(await fs.readFile('/app/data/actual-arrival-history-repair-2026-09-19.json', 'utf8'));
  const missingIds = new Set(Object.values(ledger.results).flatMap(entry => entry.unresolvedStops.flatMap(stop => stop.recordIds)).map(String));
  const expectedUnavailable = state.arrivals.filter(row => !row.actualArrival && missingIds.has(String(row.recordId)));
  let surfacedUnavailable = 0;
  const byDate = new Map();
  for (const date of new Set(state.arrivals.map(row => row.date))) {
    const records = await listDriverJobStatuses({ planDate: date });
    byDate.set(date, records);
    for (const expected of expectedUnavailable.filter(row => row.date === date)) {
      const actual = records.find(row => row.job_id === expected.jobId && row.driver_login === expected.driver);
      assert.equal(actual?.actual_arrival_resolution_status, 'unresolved', `Missing warning: ${date} ${expected.driver} ${expected.orders}`);
      surfacedUnavailable++;
    }
  }
  const reconciliation = (await query(`SELECT
    (SELECT count(*)::int FROM dispatch_actual_arrival_runs WHERE requested_by='system:actual-arrival-history-repair-v2' AND status='applied') AS "appliedRoutes",
    (SELECT count(DISTINCT record_id)::int FROM dispatch_actual_arrival_run_stops stop
      JOIN dispatch_actual_arrival_runs run ON run.run_id=stop.run_id
      CROSS JOIN LATERAL unnest(stop.driver_job_record_ids) AS record_id
      WHERE run.requested_by='system:actual-arrival-history-repair-v2' AND run.status='applied') AS "recordsAttempted"`)).rows[0];
  const wanted = new Set(["SOA08493", "SOA08668", "SOA08669", "SOA08792", "SOA08793", "SOB120596", "SOB120594", "TOB01111", "TOB01114"]);
  for (const date of ["2026-09-14", "2026-09-15", "2026-09-18", "2026-09-19"]) {
    const started = performance.now();
    const records = await listDriverJobStatuses({ planDate: date });
    const statusQueryMs = performance.now() - started;
    const plans = await query("SELECT id FROM dispatch_plans WHERE plan_date=$1 ORDER BY id", [date]);
    for (const row of plans.rows) {
      const plan = await getDispatchPlan(row.id);
      const forecast = buildDispatchForecast(plan, records);
      for (const record of records.filter(record => Number(record.plan_id) === Number(row.id) && (record.order_refs || []).some(ref => wanted.has(ref)))) {
        const stop = forecast.stops.find(stop => stop.loadId === record.load_id && stop.visitStopIds.includes(record.stop_id));
        if (stop) {
          examples.push({ date, planId: row.id, driver: record.driver_login, orders: record.order_refs,
            stopType: record.stop_type, pwaStartedAt: record.started_at, completedAt: record.completed_at,
            statusQueryMs: Number(statusQueryMs.toFixed(1)), ...stop });
        }
      }
    }
  }
  const unresolvedExamples = examples.filter(row => row.actualArrivalSource === 'unresolved');
  assert.ok(unresolvedExamples.length >= 3, 'September 19 unresolved examples must expose the warning');
  assert.ok(unresolvedExamples.every(row => row.actualArrival === null));
  console.log(JSON.stringify({ ...state, reconciliation, examples,
    displayValidation: { expectedUnavailableRecords: expectedUnavailable.length, surfacedUnavailableRecords: surfacedUnavailable } }));
} finally {
  await closeDb();
}
