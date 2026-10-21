// Read-only live SQL profiling. No plans, orders or workflow state are changed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { pool, query, closeDb } from '../src/db.js';
import { listFulfilledSalesDeliveryStates } from '../src/dispatch-fulfilled-so-repository.js';
import { listDriverPwaCompletedDispatchRefs } from '../src/dispatch-history-mode.js';

pool.options.options = '-c jit=off -c default_transaction_read_only=on -c statement_timeout=15000';
const output = process.argv[2] || '/tmp/dispatch-contention';
mkdirSync(output, { recursive: true });
const run = pool.query.bind(pool);
const captured = [];
pool.query = async (sql, params) => {
  const started = performance.now();
  const result = await run(sql, params);
  if (sql.includes('SELECT candidate.*') || sql.includes('WITH RECURSIVE group_relations AS')) {
    captured.push({ sql, params, ms: Math.round(performance.now() - started), rows: result.rowCount });
  }
  return result;
};
try {
  const { rows } = await query(`SELECT DISTINCT item->>'id' AS ref FROM dispatch_plans p
    JOIN dispatch_plan_snapshots s ON s.plan_id=p.id CROSS JOIN LATERAL jsonb_array_elements(s.orders) item
    WHERE p.plan_date=current_date AND item->>'type'='SO'`);
  const refs = rows.map(row => row.ref);
  const states = await listFulfilledSalesDeliveryStates(refs);
  const completed = await listDriverPwaCompletedDispatchRefs();
  writeFileSync(`${output}/results.json`, JSON.stringify({ refs, states: [...states], completed: [...completed].sort() }));
  const report = [];
  for (let i = 0; i < captured.length; i++) {
    const { sql, params, ms, rows: count } = captured[i];
    const explained = await run(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    writeFileSync(`${output}/query-${i}.json`, JSON.stringify({ sql, params, explain: explained.rows[0]['QUERY PLAN'] }, null, 2));
    report.push({ query: i, kind: sql.includes('SELECT candidate.*') ? 'sales-state' : 'driver-completion', ms, rows: count, explainMs: explained.rows[0]['QUERY PLAN'][0]['Execution Time'] });
  }
  writeFileSync(`${output}/summary.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await closeDb(); }
