import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';

after(closeDb);
const expected = [
  ['sales_orders', 'idx_sales_orders_dispatch_ref_lower', 'lower(btrim(tranid))'],
  ['sales_orders', 'idx_sales_orders_dispatch_id_text', '(netsuite_id)::text'],
  ['purchase_orders', 'idx_purchase_orders_dispatch_tranid_lower', 'lower(btrim(tranid))'],
  ['purchase_orders', 'idx_purchase_orders_dispatch_ref_lower', 'lower(btrim(dispatch_ref))'],
  ['purchase_orders', 'idx_purchase_orders_dispatch_id_text', '(netsuite_id)::text']
];

for (const [table, name, expression] of expected) {
  test(`${table} identity lookup uses a valid nonunique index on ${expression}`, async () => {
    const row = (await query(`SELECT t.relname AS table_name,i.indisvalid,i.indisready,i.indisunique,
      pg_get_expr(i.indexprs,i.indrelid) AS expression,am.amname
      FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am am ON am.oid=idx.relam
      WHERE idx.relname=$1 AND idx.relnamespace='public'::regnamespace`, [name])).rows[0];
    assert.ok(row, `${name} is missing; this lookup falls back to repeated table scans`);
    assert.deepEqual(row, { table_name: table, indisvalid: true, indisready: true, indisunique: false,
      expression, amname: 'btree' });
  });
}
