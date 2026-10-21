import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../src/db.js';

// A guarded spelling correction only; stock, pricing, decisions and item names stay intact.
const select = `SELECT r.id,r.revision,c.vendor_id,c.vendor_name,c.close_status,
  c.sales_order_netsuite_id,c.purchase_order_netsuite_id,c.sales_order_skipped,c.purchase_order_skipped,
  to_jsonb(l) AS line FROM sales_stock_requests r
  JOIN sales_special_stock_cases c ON c.request_id=r.id
  JOIN sales_special_stock_lines l ON l.request_id=r.id
  WHERE r.request_ref=$1 AND r.id=$2 AND l.id=$3`;
const params = ['SPREQ-000016', 80, 25];
try {
  const inspect = (await query(select, params)).rows[0];
  assert(inspect, 'The specified case line was not found');
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ requestRef: params[0], revision: inspect.revision,
      previousBrand: inspect.line.brand, correctedBrand: inspect.vendor_name, productName: inspect.line.product_name, readOnly: true }));
  } else {
    const result = await withTransaction(async () => {
      const row = (await query(select + ' FOR UPDATE OF r,c,l', params)).rows[0];
      assert(row && row.vendor_name === 'BWS' && Number(row.vendor_id) === 330);
      assert.equal(Number(row.line.response_vendor_id), 330);
      assert.equal(row.line.response_vendor_name, 'BWS');
      if (row.line.brand === 'BWS') return { alreadyCorrect: true, revision: row.revision };
      assert.equal(row.line.brand, 'best wat');
      assert.equal(row.close_status, 'active');
      assert(!row.sales_order_netsuite_id && !row.purchase_order_netsuite_id && !row.sales_order_skipped && !row.purchase_order_skipped);
      const updated = await query('UPDATE sales_special_stock_lines SET brand=$3,updated_at=now() WHERE request_id=$1 AND id=$2 RETURNING to_jsonb(sales_special_stock_lines) AS line', [80, 25, 'BWS']);
      const { brand: _beforeBrand, updated_at: _beforeUpdated, ...before } = row.line;
      const { brand: _afterBrand, updated_at: _afterUpdated, ...after } = updated.rows[0].line;
      assert.deepEqual(after, before, 'Only the vendor label may change');
      await query(`INSERT INTO sales_special_stock_events(request_id,case_line_id,event_type,actor_id,audience,details)
        VALUES($1,$2,'special_item_name_corrected',NULL,'sales_scm',$3::jsonb)`, [80, 25, JSON.stringify({
        previousBrand: 'best wat', brand: 'BWS', previousProductName: row.line.product_name, productName: row.line.product_name,
        source: 'user_requested_typo_correction' })]);
      await query('UPDATE sales_special_stock_cases SET updated_at=now() WHERE request_id=$1', [80]);
      const revision = (await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision', [80])).rows[0].revision;
      return { requestRef: params[0], lineId: 25, previousBrand: 'best wat', brand: 'BWS', productName: row.line.product_name, revision, audited: true };
    });
    console.log(JSON.stringify(result));
  }
} finally { await closeDb(); }
