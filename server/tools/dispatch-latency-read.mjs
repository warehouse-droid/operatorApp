// Operational diagnosis only: read-only connections, bounded queries, no payload output.
import { performance } from 'node:perf_hooks';
import { pool } from '../src/db.js';

const statements = [];
pool.on('connect', client => {
  const original = client.query.bind(client);
  void original("SET default_transaction_read_only=on; SET statement_timeout='5s'; SET lock_timeout='1s'");
  client.query = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
    const start = performance.now();
    const record = () => {
      const statement = { ms: Math.round(performance.now() - start), tables: [...new Set(sql.match(/(?:FROM|JOIN|UPDATE|INTO)\s+[a-z_][a-z_0-9]*/gi) || [])].slice(0, 8).join(' '), sqlLength: sql.length };
      Object.defineProperties(statement, { sql: { value: sql }, params: { value: Array.isArray(args[1]) ? args[1] : [] } });
      statements.push(statement);
    };
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = (...values) => { record(); callback(...values); };
      return original(...args);
    }
    return original(...args).finally(record);
  };
});
globalThis.fetch = async () => { throw new Error('External/network requests are disabled during read-only diagnosis'); };
const deadline = setTimeout(() => process.exit(2), 45000);
try {
  const { loadDispatchOrdersForResponse } = await import('../src/server.js');
  const { getDispatchOrderCatalogOrder } = await import('../src/dispatch-order-catalog-repository.js');
  const { getDispatchPlan } = await import('../src/dispatch-plan-repository.js');
  const refs = (await pool.query(`SELECT DISTINCT ON (order_type) order_type,order_ref
    FROM dispatch_order_catalog_entries WHERE eligible=true AND order_type IN ('SO','PO','TO')
    ORDER BY order_type,activity_at DESC`)).rows;
  for (const row of refs) {
    for (const [kind, read] of [['catalog', () => getDispatchOrderCatalogOrder(row.order_ref)],
      ['fresh', () => loadDispatchOrdersForResponse({ search: row.order_ref, exactOrderRefs: [row.order_ref], includeCompletedScmSearch: true })]]) {
      statements.length = 0;
      const start = performance.now();
      try {
        const result = await read();
        console.log(JSON.stringify({ kind, orderType: row.order_type, ms: Math.round(performance.now() - start), returned: Array.isArray(result) ? result.length : Number(Boolean(result)), queries: statements.length,
          slowest: statements.sort((a,b) => b.ms-a.ms).slice(0,5) }));
        if (globalThis.dispatchLatencyExplain && kind === 'fresh' && row.order_type === 'PO') {
          const statement = statements.find(item => item.sql.includes('target.target_state'));
          if (statement) {
            const queryPlan = await pool.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + statement.sql, statement.params);
            const flatten = node => [node, ...(node.Plans || []).flatMap(flatten)];
            console.log(JSON.stringify({ explain: flatten(queryPlan.rows[0]['QUERY PLAN'][0].Plan).map(node => ({
              type: node['Node Type'], relation: node['Relation Name'], alias: node.Alias,
              rows: node['Actual Rows'], loops: node['Actual Loops'], ms: node['Actual Total Time']
            })).filter(node => node.ms > 5) }));
          }
        }
      } catch (error) { console.log(JSON.stringify({ kind, orderType: row.order_type, ms: Math.round(performance.now() - start), error: error.code || error.message, queries: statements.length, slowest: statements.sort((a,b) => b.ms-a.ms).slice(0,5) })); }
    }
  }
  const plans = (await pool.query(`SELECT p.id,jsonb_array_length(s.orders) AS orders,jsonb_array_length(s.trucks) AS trucks,
    pg_column_size(s.orders)+pg_column_size(s.trucks) AS bytes FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE p.status <> 'cancelled' ORDER BY p.updated_at DESC LIMIT 1`)).rows;
  for (const row of plans) {
    statements.length=0; const start=performance.now();
    try { await getDispatchPlan(row.id); console.log(JSON.stringify({ kind:'plan-read',orders:row.orders,trucks:row.trucks,storedBytes:row.bytes,ms:Math.round(performance.now()-start),queries:statements.length,slowest:statements.sort((a,b)=>b.ms-a.ms).slice(0,8) })); }
    catch(error) { console.log(JSON.stringify({kind:'plan-read',error:error.code || error.message})); }
  }
} finally { clearTimeout(deadline); await pool.end(); }
