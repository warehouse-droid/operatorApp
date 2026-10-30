// Operational reporting only: no business writes, no customer or credential fields.
import assert from 'node:assert/strict';
import { suiteql, activeNetSuiteLocationDirectory } from './src/netsuite.js';
import { query, withTransaction, closeDb } from './src/db.js';

const startDate = '2026-09-30';
const capturedAt = new Date();
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).formatToParts(capturedAt).map(part => [part.type, part.value]));
const cutoff = process.env.REPORT_CUTOFF || `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
assert.match(cutoff, /^2026-10-29 \d{2}:\d{2}:\d{2}$/);
const period = `t.type IN ('ItemShip','ItemRcpt')
  AND t.createddate >= TO_DATE('${startDate}','YYYY-MM-DD')
  AND t.createddate < TO_DATE('${cutoff}','YYYY-MM-DD HH24:MI:SS')`;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => {
  const pathname = new URL(String(url)).pathname;
  const sql = pathname.includes('/query/v1/suiteql') ? JSON.parse(options.body).q : '';
  if ((options.method || 'GET') !== 'GET' && !/^\s*SELECT\b/i.test(sql) && !pathname.includes('/token')) {
    throw new Error('The statistics reader blocked a non-read NetSuite request.');
  }
  return originalFetch(url, options);
};
const clean = rows => rows.map(({ links: _links, ...row }) => row);

try {
  if (!process.env.REPORT_RESUME) {
  const local = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout = '20s'");
    const proofs = (await query(`
      SELECT 'operator_step' AS source, transaction_type AS kind,
        netsuite_transaction_id::text AS transaction_id, external_id,
        response->>'externalId' AS observed_external_id, status,
        created_at, posted_at AS completed_at
      FROM operator_netsuite_posting_steps WHERE netsuite_transaction_id IS NOT NULL
      UNION ALL
      SELECT 'dispatch_if','IF',netsuite_transaction_id::text,external_id,
        result->'response'->>'externalId',status,created_at,completed_at
      FROM dispatch_sales_order_if_candidates WHERE netsuite_transaction_id IS NOT NULL
      UNION ALL
      SELECT 'fulfillment_part','IF',netsuite_transaction_id::text,external_id,
        response->>'externalId',status,created_at,updated_at
      FROM netsuite_item_fulfillment_parts WHERE netsuite_transaction_id IS NOT NULL
    `)).rows;
    const legacy = (await query(`
      SELECT 'delivery' AS source, 'IF' AS kind, item_fulfillment_id::text AS transaction_id,
        fulfillment_status AS status, created_at, payload->>'externalId' AS external_id,
        response->>'externalId' AS observed_external_id,
        response ? 'operatorNetSuitePosting' AS managed_posting,
        response->'operatorNetSuitePosting'->>'commandId' AS command_id,
        (SELECT jsonb_agg(key) FROM jsonb_object_keys(response) AS key) AS response_keys
      FROM delivery_fulfillment_records WHERE item_fulfillment_id IS NOT NULL
      UNION ALL
      SELECT 'receiving','IR',item_receipt_id::text,receipt_status,created_at,
        payload->>'externalId',response->>'externalId',response ? 'operatorNetSuitePosting',
        response->'operatorNetSuitePosting'->>'commandId',
        (SELECT jsonb_agg(key) FROM jsonb_object_keys(response) AS key)
      FROM receiving_receipt_records WHERE item_receipt_id IS NOT NULL
    `)).rows;
    const pending = (await query(`SELECT transaction_type AS kind,status,count(*)::int AS count
      FROM operator_netsuite_posting_steps WHERE status IN ('posting','pending','uncertain')
      GROUP BY transaction_type,status`)).rows;
    return { proofs, legacy, pending };
  }, { rollback: true });
  console.log(JSON.stringify({ phase: 'local', ...local }));
  const locations = clean(await activeNetSuiteLocationDirectory());
  console.log(JSON.stringify({ phase: 'locations', locations }));
  const totals = clean((await suiteql(`SELECT t.type,t.status,COUNT(*) AS count FROM transaction t
    WHERE ${period} GROUP BY t.type,t.status`)).items || []);
  console.log(JSON.stringify({ phase: 'totals', capturedAt: capturedAt.toISOString(), startDate,
    cutoff, timeZone: 'America/Toronto', dateBasis: 'NetSuite transaction creation date', totals }));
  }
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await suiteql(`SELECT t.id,t.tranid,t.type,t.status,t.externalid,t.createdby,
      TO_CHAR(t.createddate,'YYYY-MM-DD HH24:MI:SS') AS created_at,
      TO_CHAR(t.trandate,'YYYY-MM-DD') AS transaction_date
      FROM transaction t
      WHERE ${period}
      ORDER BY t.id`, [], { limit: 1000, offset });
    const items = clean(page.items || []);
    rows.push(...items);
    console.log(JSON.stringify({ phase: 'headers', offset, count: items.length, hasMore: page.hasMore, rows: items }));
    if (!page.hasMore) break;
    assert.equal(items.length, 1000, 'Unexpected pagination size');
    assert.ok(offset < 50000, 'Unexpected report size');
  }
  let locationRows = 0;
  for (let offset = 0; ; offset += 1000) {
    const page = await suiteql(`SELECT DISTINCT t.id,tl.location AS location_id
      FROM transaction t JOIN transactionline tl ON tl.transaction=t.id
      WHERE ${period} AND tl.mainline='F' AND (tl.taxline='F' OR tl.taxline IS NULL)
        AND tl.item IS NOT NULL AND NVL(tl.quantity,0)<>0
      ORDER BY t.id,tl.location`, [], { limit: 1000, offset });
    const items = clean(page.items || []);
    locationRows += items.length;
    console.log(JSON.stringify({ phase: 'transaction-locations', offset, count: items.length, hasMore: page.hasMore, rows: items }));
    if (!page.hasMore) break;
    assert.equal(items.length, 1000, 'Unexpected location pagination size');
    assert.ok(offset < 50000, 'Unexpected location report size');
  }
  const unique = new Map(rows.map(row => [String(row.id), row]));
  assert.equal(unique.size, rows.length, 'Duplicate transaction headers');
  console.log(JSON.stringify({ phase: 'verified', uniqueTransactions: unique.size,
    transactionLocationRows: locationRows, capturedAt: capturedAt.toISOString() }));
} finally {
  globalThis.fetch = originalFetch;
  await closeDb();
}
