import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const manifest = Object.freeze(Array.from({length:8}, (_,i) => ({id:57+i,ref:`SPREQ-${String(i+2).padStart(6,'0')}`})));
export const tables = Object.freeze([
  'sales_stock_requests','sales_special_stock_cases','sales_special_stock_lines',
  'sales_special_stock_order_lines','sales_special_stock_media','sales_special_stock_handoffs',
  'sales_special_stock_events','sales_special_stock_document_cache',
  'sales_stock_request_lines','sales_stock_request_events','sales_stock_transfers'
]);
const ids = manifest.map(row => row.id);
const knownDependents = [...tables,'sales_stock_transfer_lines','sales_stock_transfer_reservations'].sort();
export const digest = text => createHash('sha256').update(text).digest('hex');
const condition = table => `${table === 'sales_stock_requests' ? 'id' : 'request_id'} = ANY($1::bigint[])`;

export function validate(snapshot) {
  assert.deepEqual(snapshot.rows.sales_stock_requests.map(row => ({id:row.id,ref:row.request_ref})).sort((a,b)=>a.id-b.id),manifest,'Authorized request identities changed');
  assert.ok(snapshot.rows.sales_stock_requests.every(row => row.request_type === 'special'),'Only special requests may be removed');
  assert.deepEqual(snapshot.rows.sales_special_stock_cases.map(row => row.request_id).sort((a,b)=>a-b),ids,'Case identities changed');
  for (const table of tables) for (const row of snapshot.rows[table]) {
    assert.ok(ids.includes(row[table === 'sales_stock_requests' ? 'id' : 'request_id']),'Snapshot contains an unauthorized request');
  }
  for (const row of snapshot.rows.sales_special_stock_cases) {
    assert.ok(!['creating','applying','closing'].includes(row.sales_order_operation_status),'SO operation in progress');
    assert.ok(!['creating','applying','closing'].includes(row.purchase_order_operation_status),'PO operation in progress');
    assert.notEqual(row.quantity_review?.status,'applying','Quantity operation in progress');
    assert.notEqual(row.closure_review?.status,'applying','Closure operation in progress');
  }
  assert.equal(snapshot.rows.sales_stock_transfers.length,0,'A transfer needs separate review');
  assert.equal(snapshot.rows.sales_special_stock_media.length,0,'Uploaded media needs separate review');
  assert.deepEqual([...new Set(snapshot.foreignKeys.map(row=>row.child))].filter(table=>!knownDependents.includes(table)),[],'Unknown dependent table');
}

export async function capture(client) {
  const parts = tables.map(table => `'${table}',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text) FROM ${table} r WHERE ${condition(table)}),'[]'::jsonb)`);
  const sql = `WITH RECURSIVE deps AS (SELECT 'sales_stock_requests'::regclass::oid AS rel UNION SELECT c.conrelid FROM pg_constraint c JOIN deps d ON c.confrelid=d.rel WHERE c.contype='f')
    SELECT jsonb_build_object('rows',jsonb_build_object(${parts.join(',')}),'foreignKeys',
    (SELECT jsonb_agg(jsonb_build_object('child',conrelid::regclass::text,'parent',confrelid::regclass::text,'definition',pg_get_constraintdef(oid)) ORDER BY conrelid::regclass::text,conname) FROM pg_constraint WHERE contype='f' AND confrelid IN(SELECT rel FROM deps)))::text AS payload`;
  return (await client.query(sql,[ids])).rows[0].payload;
}

async function preserved(client) {
  const filters = {
    ...Object.fromEntries(tables.map(table => [table,`NOT (${condition(table)})`])),
    sales_orders: 'netsuite_id IN (1017068,1017268)', sales_order_lines: 'sales_order_id IN (1017068,1017268)',
    purchase_orders: 'netsuite_id=1017168', purchase_order_lines: 'purchase_order_id=1017168',
    sales_stock_transfer_lines:'true', sales_stock_transfer_reservations:'true'
  };
  const parts = Object.entries(filters).map(([table,where]) => `'${table}',jsonb_build_object('count',(SELECT count(*) FROM ${table} WHERE ${where}), 'hash',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text) FROM ${table} r WHERE ${where}))`);
  return (await client.query(`SELECT jsonb_build_object(${parts.join(',')})::text AS payload`,[ids])).rows[0].payload;
}

export async function execute(client, {mode, expected} = {}) {
  assert.ok(['backup','rehearse','apply'].includes(mode),'Unknown cleanup mode');
  await client.query(`BEGIN ISOLATION LEVEL SERIALIZABLE${mode === 'backup' ? ' READ ONLY' : ''}`);
  try {
    await client.query("SET LOCAL lock_timeout='750ms'");
    await client.query("SET LOCAL statement_timeout='5s'");
    if (mode !== 'backup') for (const table of tables) await client.query(`SELECT 1 FROM ${table} WHERE ${condition(table)} FOR UPDATE`,[ids]);
    const payload = await capture(client);
    const snapshot = JSON.parse(payload);
    validate(snapshot);
    if (mode === 'backup') { await client.query('ROLLBACK'); return {payload}; }
    assert.equal(digest(payload),expected,'Backup no longer matches the locked requests; nothing removed');
    const before = await preserved(client);
    // Explicitly remove referencing order lines before the case-line RESTRICT constraint.
    await client.query('DELETE FROM sales_special_stock_order_lines WHERE request_id=ANY($1::bigint[])',[ids]);
    const deleted = await client.query("DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[]) AND request_type='special' RETURNING id,request_ref",[ids]);
    assert.deepEqual(deleted.rows.map(row=>({id:Number(row.id),ref:row.request_ref})).sort((a,b)=>a.id-b.id),manifest,'Deletion scope mismatch');
    const empty = JSON.parse(await capture(client));
    assert.ok(Object.values(empty.rows).every(rows=>rows.length === 0),'Request dependencies remain');
    assert.equal(await preserved(client),before,'Unrelated requests or linked orders changed; rolling back');
    if (mode === 'rehearse') {
      for (const table of tables) if (snapshot.rows[table].length) await client.query(`INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(snapshot.rows[table])]);
      assert.equal(await capture(client),payload,'Restored snapshot differs from backup');
      assert.equal(await preserved(client),before,'Restoration changed unrelated data');
      await client.query('ROLLBACK');
    } else await client.query('COMMIT');
    return {mode,requests:manifest,backupSha256:expected,removed:mode==='apply'?ids.length:0,restorationVerified:mode==='rehearse',preserved:JSON.parse(before),counts:Object.fromEntries(tables.map(table=>[table,snapshot.rows[table].length])),netSuiteRequests:0};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
