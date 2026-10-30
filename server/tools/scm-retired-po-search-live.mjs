import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {listScmSchedule} from './src/dispatch-repository.js';
import {enrichScmScheduleWithReconciliation} from './src/scm-reconciliation-repository.js';

try {
  await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const rows=await enrichScmScheduleWithReconciliation(
      await listScmSchedule({search:'3429',audience:'schedule_search'}),{includeDetails:false});
    const ledger=(await query(`SELECT split.id,split.split_po_id,split.split_po_ref,split.status,
      po.netsuite_active,(SELECT count(*)::int FROM dispatch_scm_po_split_lines line WHERE line.split_id=split.id) AS saved_lines
      FROM dispatch_scm_po_splits split JOIN purchase_orders po ON po.netsuite_id=split.split_po_id
      WHERE split.id IN (332,334) ORDER BY split.id`)).rows;
    if (process.argv[2]==='after') {
      assert.ok(!rows.some(row=>String(row.sourceId)==='-211363081021779'));
      const active=rows.filter(row=>String(row.sourceId)==='-88518552575716');
      assert.equal(active.length,1);
      assert.equal(active[0].calculatedStatus,'Completed');
      assert.equal(active[0].reconciliationStatus,'ok');
      assert.match(active[0].content,/1771\.2 SQFT/);
      assert.equal(ledger.find(row=>Number(row.id)===332).status,'cancelled');
    }
    console.log(JSON.stringify({mode:process.argv[2],at:new Date().toISOString(),ledger,rows:rows.map(row=>({
      sourceId:row.sourceId,ref:row.orderRef,status:row.calculatedStatus || row.status,
      reconciliationStatus:row.reconciliationStatus,content:row.content
    }))},null,2));
  });
} finally {await closeDb();}
