import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture} from '../test/mbt/helpers/backorder-already-ordered.js';
import {withTransaction} from '../src/db.js';

const f=await fixture({sku:88999703});
try {
  let d=await f.create();const before=(await f.query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows;
  const definition=async()=>(await f.query("SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass,true) AS definition")).rows[0].definition;
  const currentView=await definition(),rollback=Error('Intentional migration rollback');
  await assert.rejects(withTransaction(async()=>{
    await f.query(`ALTER TABLE sales_special_stock_lines DROP CONSTRAINT backorder_ordered_reference_check,
      DROP COLUMN backorder_po_number,DROP COLUMN backorder_po_ref_number`);
    await f.query(await readFile('/baseline/migrations/270_backorder_order_completion.sql','utf8'));
    await f.query(await readFile('/app/migrations/274_backorder_already_ordered.sql','utf8'));
    assert.deepEqual((await f.query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows,before);
    assert.equal(await definition(),currentView);
    throw rollback;
  }),error=>error===rollback);
  assert.equal(await definition(),currentView);
  assert.deepEqual((await f.query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows,before);
  for(const number of ['', ' ', 'x'.repeat(121), 'PO\nBAD']) {
    await assert.rejects(f.query("UPDATE sales_special_stock_lines SET supply_status='already_ordered',backorder_po_number=$2 WHERE id=$1",[d.lines[0].id,number]),{code:'23514'});
  }
  assert.deepEqual((await f.query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows,before);
  d=await f.ordered(d);assert.equal(d.lines[0].completed,true);assert.equal(d.lines[1].completed,false);
  console.log(JSON.stringify({migrationReplayPreservedRows:true,transactionalRollbackPreservedSchema:true,databaseConstraintRejections:4,completionAfterRollback:true}));
}finally{await f.close();}
