import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { closeDb, query } from '../../../src/db.js';
import { upsertSalesOrderLines } from '../../../src/order-sync-repository.js';
import { scenario, seedSalesOrder } from '../support/fulfilled-so-fixture.js';

after(closeDb);
const id = 817158901;
const progress = ['packed_pallet_qty','packed_layer_qty','packed_section_qty','packed_piece_qty','confirmed','confirmed_at',
  'loaded_qty','loaded_uom','fulfilled_pallet_qty','fulfilled_layer_qty','fulfilled_piece_qty','fulfilled_section_qty','packed_sales_qty'];

async function heldLine() {
  await seedSalesOrder(id, 'SO-LOCAL-UNIT-HOLD');
  await query("UPDATE sales_order_lines SET quantity=28,unit='PC',pallet_qty=0,piece_qty=7,loaded_qty=28,loaded_uom='PC',synced_at=now()-interval '1 day' WHERE id=$1", [id]);
  const before = (await query('SELECT * FROM sales_order_lines WHERE id=$1', [id])).rows[0];
  await query("UPDATE sales_order_lines SET unit='SQFT',loaded_uom='SQFT' WHERE id=$1", [id]);
  await query(`INSERT INTO sales_order_line_sync_holds(sales_order_line_id,source_snapshot,before_state,reason,created_by)
    SELECT id,to_jsonb(line)-$2::text[],$3::jsonb,'Retain local unit correction','testAdmin'
      FROM sales_order_lines line WHERE id=$1`, [id, progress, JSON.stringify(before)]);
  return before;
}

test('held line remains 28 SQFT and seven pieces through the real NetSuite line upsert', () => scenario(async () => {
  await heldLine();
  await upsertSalesOrderLines(id, [{line_id:1,item_id:817159900,item_name:'Test cargo',sku:'FULFILLED-TEST',
    item_type:'NonInvtPart',quantity:28,unit:'PC',piece_qty:28,netsuite_received_qty:112}]);
  const row = (await query('SELECT * FROM sales_order_lines WHERE id=$1', [id])).rows[0];
  assert.equal(Number(row.quantity), 28);
  assert.equal(row.unit, 'SQFT');
  assert.equal(Number(row.piece_qty), 7);
  assert.equal(Number(row.loaded_qty), 28);
  assert.equal(row.loaded_uom, 'SQFT');
}));

test('a held line remains active when sync deactivates missing source lines', () => scenario(async () => {
  await heldLine();
  await query("UPDATE sales_order_lines SET netsuite_active=false,sync_exception='line_removed',synced_at=clock_timestamp() WHERE sales_order_id=$1", [id]);
  const row = (await query('SELECT netsuite_active,sync_exception FROM sales_order_lines WHERE id=$1', [id])).rows[0];
  assert.equal(row.netsuite_active, true);
  assert.equal(row.sync_exception, null);
}));

test('holding one line does not freeze sibling line synchronization or local packing/loading', () => scenario(async () => {
  await heldLine();
  await upsertSalesOrderLines(id, [{line_id:2,item_id:817159901,item_name:'Other cargo',sku:'OTHER',quantity:60,unit:'SQFT'}]);
  await upsertSalesOrderLines(id, [{line_id:2,item_id:817159901,item_name:'Other cargo',sku:'OTHER',quantity:64,unit:'SQFT'}]);
  assert.equal(Number((await query('SELECT quantity FROM sales_order_lines WHERE sales_order_id=$1 AND line_id=2', [id])).rows[0].quantity), 64);
  await query('UPDATE sales_order_lines SET packed_piece_qty=7,packed_sales_qty=28,confirmed=true,loaded_qty=27 WHERE id=$1', [id]);
  const row = (await query('SELECT * FROM sales_order_lines WHERE id=$1', [id])).rows[0];
  assert.equal(Number(row.packed_piece_qty), 7); assert.equal(Number(row.packed_sales_qty), 28);
  assert.equal(row.confirmed, true); assert.equal(Number(row.loaded_qty), 27); assert.equal(row.unit, 'SQFT');
}));

test('explicit release resumes sync and retains the original correction evidence', () => scenario(async () => {
  const before = await heldLine();
  await query("UPDATE sales_order_line_sync_holds SET released_at=now(),released_by='testAdmin' WHERE sales_order_line_id=$1", [id]);
  await upsertSalesOrderLines(id, [{line_id:1,item_id:817159900,item_name:'Test cargo',sku:'FULFILLED-TEST',quantity:32,unit:'PC'}]);
  const row = (await query('SELECT quantity,unit FROM sales_order_lines WHERE id=$1', [id])).rows[0];
  assert.deepEqual({quantity:Number(row.quantity),unit:row.unit}, {quantity:32,unit:'PC'});
  assert.deepEqual((await query('SELECT before_state FROM sales_order_line_sync_holds WHERE sales_order_line_id=$1', [id])).rows[0].before_state, JSON.parse(JSON.stringify(before)));
}));

test('holds cannot alter another line identity or capture Operator progress fields', async () => {
  for (const patch of [{id:id+1}, {packed_piece_qty:0}]) {
    await assert.rejects(scenario(async () => {
      await heldLine();
      await query('UPDATE sales_order_line_sync_holds SET source_snapshot=source_snapshot||$2::jsonb WHERE sales_order_line_id=$1', [id,JSON.stringify(patch)]);
    }), error => error.code === '23514');
  }
});

test('property: incoming quantities and unit labels cannot overwrite a held line', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min:0,max:10000}),fc.constantFrom('PC','SQFT','EA','PALLET'),
    async (quantity,unit) => scenario(async () => {
      await heldLine();
      await query('UPDATE sales_order_lines SET quantity=$2,unit=$3,piece_qty=$2,loaded_qty=$2,synced_at=clock_timestamp() WHERE id=$1', [id,quantity,unit]);
      const row=(await query('SELECT quantity,unit,piece_qty,loaded_qty FROM sales_order_lines WHERE id=$1',[id])).rows[0];
      assert.deepEqual({quantity:Number(row.quantity),unit:row.unit,pieces:Number(row.piece_qty),loaded:Number(row.loaded_qty)},
        {quantity:28,unit:'SQFT',pieces:7,loaded:28});
    })), {seed:20261015,numRuns:16});
});

test('empty hold schema rollback and reapply are reversible', () => scenario(async () => {
  await query(readFileSync('tools/som06964-release-20261015/rollback-empty-hold-schema.sql','utf8'));
  assert.equal((await query("SELECT to_regclass('sales_order_line_sync_holds') AS name")).rows[0].name,null);
  await query(readFileSync('migrations/292_sales_order_line_sync_holds.sql','utf8'));
  await heldLine();
  await query("UPDATE sales_order_lines SET unit='PC',synced_at=clock_timestamp() WHERE id=$1",[id]);
  assert.equal((await query('SELECT unit FROM sales_order_lines WHERE id=$1',[id])).rows[0].unit,'SQFT');
}));

test('schema rollback refuses to discard operational hold evidence', async () => {
  await assert.rejects(scenario(async () => {
    await heldLine();
    await query(readFileSync('tools/som06964-release-20261015/rollback-empty-hold-schema.sql','utf8'));
  }), /Retain local hold audit records/u);
});
