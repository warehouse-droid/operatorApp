// Read-only post-release validation; safe to pipe into node from the app cwd.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const moduleAt = file => import(pathToFileURL(resolve('src', file)).href);
const { query, withTransaction, closeDb } = await moduleAt('db.js');
const { persistedDispatchPlan } = await moduleAt('dispatch-plan-fence.js');
const { getDispatchPlanRevision } = await moduleAt('dispatch-plan-repository.js');
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await query("SET LOCAL statement_timeout='10s'");
    const rows = (await query(`SELECT p.id, p.plan_date::text, p.status, p.note, p.revision,
      s.orders, s.trucks, s.summary, s.saved_at FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id ORDER BY p.id`)).rows;
    const fenceMismatches = [];
    for (const row of rows) {
      const expected = persistedDispatchPlan(row);
      const actual = await getDispatchPlanRevision(row.id);
      if (actual.digest !== expected.digest || actual.revision !== expected.revision) fenceMismatches.push(String(row.id));
    }
    assert.deepEqual(fenceMismatches, []);
    return { readOnly: true, plansChecked: rows.length, fenceMismatches };
  });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
