// Post-deployment reads only; no synthetic saves or edits of production plans.
import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from './src/db.js';
import { persistedDispatchPlan } from './src/dispatch-plan-fence.js';
import { getDispatchPlanRevision } from './src/dispatch-plan-repository.js';

try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await query("SET LOCAL statement_timeout='10s'");
    const migration = (await query("SELECT filename FROM schema_migrations WHERE filename='205_dispatch_plan_maintenance.sql'")).rows;
    assert.equal(migration.length, 1);
    const rows = (await query(`SELECT p.id,p.plan_date::text,p.status,p.note,p.revision,
      s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id ORDER BY p.id`)).rows;
    const mismatches = [];
    for (const row of rows) {
      const expected = persistedDispatchPlan(row);
      const actual = await getDispatchPlanRevision(row.id);
      if (actual.digest !== expected.digest || actual.revision !== expected.revision) mismatches.push(String(row.id));
    }
    assert.deepEqual(mismatches, []);
    const maintenance = (await query(`SELECT count(*)::int AS pending,
      count(*) FILTER (WHERE last_error<>'')::int AS errors,
      count(*) FILTER (WHERE available_at<=now())::int AS due FROM dispatch_plan_maintenance`)).rows[0];
    assert.equal(maintenance.errors, 0);
    return { readOnly: true, migration: migration[0].filename, plansChecked: rows.length,
      fenceMismatches: mismatches, maintenance };
  });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
