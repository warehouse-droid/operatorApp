// Operational, read-only diagnostics. Runs in a bounded transient systemd unit.
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pool, closeDb } from '/app/src/db.js';
import { config } from '/app/src/config.js';

pool.options.options = '-c jit=off -c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=2000 -c application_name=mbbs_readonly_load_diagnostic';
const labels = new AsyncLocalStorage();
const observations = [];
const captured = [];
const originalQuery = pool.query.bind(pool);
pool.query = async (...args) => {
  const started = performance.now();
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
  try {
    const result = await originalQuery(...args);
    captured.push({ label: labels.getStore() || '', sql, params: args[1] || [], ms: performance.now() - started, rows: result.rowCount });
    return result;
  } catch (error) {
    captured.push({ label: labels.getStore() || '', sql, params: [], ms: performance.now() - started, error: error.code });
    throw error;
  }
};
const redact = sql => sql.replace(/'(?:''|[^'])*'/g, "'?'").replace(/\s+/g, ' ').trim();
async function measure(label, read) {
  const start = performance.now();
  const startIndex = captured.length;
  let value;
  let error;
  try { value = await labels.run(label, read); } catch (e) { error = { code: e.code, message: e.message }; }
  const queries = captured.slice(startIndex);
  const groups = new Map();
  for (const q of queries) {
    const sql = redact(q.sql);
    const group = groups.get(sql) || { sql, count: 0, summedMs: 0, maxMs: 0 };
    group.count++;
    group.summedMs += q.ms;
    group.maxMs = Math.max(group.maxMs, q.ms);
    groups.set(sql, group);
  }
  const row = { label, ms: Math.round(performance.now() - start), rows: Array.isArray(value) ? value.length : null, bytes: value ? Buffer.byteLength(JSON.stringify(value)) : 0, queryCount: queries.length,
    selectedDeliveryMethod: (Array.isArray(value) ? value[0] : value)?.regular?.deliveryMethod || null,
    error, queries: [...groups.values()].sort((a,b) => b.summedMs - a.summedMs).map(g => ({...g, summedMs: Math.round(g.summedMs), maxMs: Math.round(g.maxMs)})) };
  observations.push(row);
  console.log(JSON.stringify({kind:'measurement', ...row}));
  return value;
}

try {
  console.log(JSON.stringify({kind:'runtime',netSuiteDirectAccessEnabled:config.netsuite?.directAccessEnabled===true}));
  const settings = await pool.query("SELECT current_setting('transaction_read_only') AS read_only, current_setting('statement_timeout') AS statement_timeout");
  if (settings.rows[0].read_only !== 'on') {throw Error('Read-only database session required');}
  console.log(JSON.stringify({kind:'settings',...settings.rows[0],at:new Date().toISOString()}));
  const special = await import('/app/src/special-stock-request-repository.js');
  const regular = await import('/app/src/stock-request-repository.js');
  const alerts = await import('/app/src/special-stock-alerts.js');
  const yards = [1,28,15,26];
  for (let sample = 1; sample <= 2; sample++) {
    await measure(`special-scm-list-${sample}`, () => special.listSpecialStockCases({audience:'scm',limit:60}));
    await measure(`special-sales-list-${sample}`, () => special.listSpecialStockCases({audience:'sales',authorizedStoreLocationIds:yards,limit:60}));
    const sales = await measure(`regular-sales-list-${sample}`, () => regular.listSalesStockRequests({authorizedDestinationLocationIds:yards,bucket:'pending',limit:100}));
    if (sales?.length) {await measure(`regular-sales-first-detail-${sample}`, () => regular.getSalesStockRequest(sales[0].id,{authorizedDestinationLocationIds:yards}));}
    const scm = await measure(`regular-scm-list-${sample}`, () => regular.listScmStockRequests({queue:'request',limit:100}));
    if (scm?.length) {await measure(`regular-scm-first-detail-${sample}`, () => regular.getScmStockRequest(scm[0].id));}
  }
  await measure('special-scm-alert-counts', () => alerts.getSpecialStockAlertCounts());
  await measure('special-vendor-filter', () => special.listSpecialCaseVendors());
  await measure('regular-filters', () => regular.listStockRequestFilterOptions());
  const distinctSlow = new Map();
  for (const row of captured.filter(r => !r.error && r.ms > 100 && /^(\s*SELECT|\s*WITH)\b/i.test(r.sql)).sort((a,b) => b.ms-a.ms)) {
    if (!distinctSlow.has(row.sql)) {distinctSlow.set(row.sql,row);}
  }
  for (const [index,q] of [...distinctSlow.values()].slice(0,3).entries()) {
    try {
      const result = await originalQuery('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) '+q.sql,q.params);
      console.log(JSON.stringify({kind:'query-plan',index,label:q.label,sql:redact(q.sql),plan:result.rows[0]['QUERY PLAN']}));
    } catch (e) { console.log(JSON.stringify({kind:'query-plan-error',index,label:q.label,code:e.code,message:e.message})); }
  }
} finally { await closeDb(); }
