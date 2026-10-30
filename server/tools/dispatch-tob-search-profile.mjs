// Operational diagnosis only: every database connection is forced read-only.
// Run through the live application's Node process environment, without starting its server.
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { pool, closeDb } from '../src/db.js';

pool.options.options = `${pool.options.options || ''} -c default_transaction_read_only=on -c statement_timeout=45000 -c application_name=dispatch_tob_readonly_profile`;
const queries = [];
pool.on('connect', client => {
  const original = client.query.bind(client);
  client.query = function (...args) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
    const id = createHash('sha256').update(sql).digest('hex').slice(0, 12);
    const started = performance.now();
    const done = (error, result) => {
      queries.push({ id, ms: Math.round(performance.now() - started), rows: result?.rowCount,
        sql: sql.replace(/\s+/g, ' ').trim().slice(0, 200), error: error?.message });
    };
    const last = args.length - 1;
    if (typeof args[last] === 'function') {
      const callback = args[last];
      args[last] = (error, result) => { done(error, result); callback(error, result); };
      return original(...args);
    }
    return original(...args).then(result => { done(null, result); return result; }, error => { done(error); throw error; });
  };
});

try {
  const { loadDispatchOrdersForResponse } = await import('../src/server.js');
  const started = performance.now();
  let orders = await loadDispatchOrdersForResponse({ search: 'TOB0126', includeCompletedScmSearch: true });
  const routeFiltered = process.env.MBBS_TOB_PROFILE_ROUTE === '1';
  if (routeFiltered) {
    const { filterOrdinaryTransportOrders } = await import('../src/mbt/bin-transport-ownership.js');
    orders = await filterOrdinaryTransportOrders(orders);
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), search: 'TOB0126', routeFiltered, ms: Math.round(performance.now() - started),
    count: orders.length, orders: orders.map(order => ({ id: order.id, type: order.type,
      planned: order.dispatchPlanned === true, date: order.dispatchPlanDate || null,
      restricted: order.dispatchSearchRestricted === true, status: order.status })),
    queries: queries.sort((left, right) => right.ms - left.ms) }, null, 2));
} finally {
  await closeDb();
}
