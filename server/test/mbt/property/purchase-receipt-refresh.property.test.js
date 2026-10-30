import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import fc from 'fast-check';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {enqueuePurchaseReceiptRefresh,applyPurchaseReceiptProgress} from '../../../src/purchase-receipt-refresh-repository.js';
import {claimDueDelayedStatusRefreshJobs,finishDelayedStatusRefreshAttempt} from '../../../src/netsuite-delayed-status-refresh-repository.js';
import {regularStockStatusSummary} from '../../../public/regular-stock-status.js';
after(closeDb);
test('property: nested source identity, duplicate signals and receipt quantities remain exact',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:3}),fc.integer({min:1,max:6}),fc.integer({min:1,max:500}),fc.boolean(),
    async(depth,signals,quantity,full)=>withTransaction(async()=>{
      const root=987771;
      await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES($1,'PROPERTY-ROOT','Pending Receipt',true)",[root]);
      let child=root;
      for(let n=1;n<=depth;n++){
        const next=-root-n;
        await query('INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active) VALUES($1,$2,true)',[next,`PROPERTY-${n}`]);
        await query('INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref) VALUES($1,$2,$3,$4)',[child,`PARENT-${n}`,next,`PROPERTY-${n}`]);
        child=next;
      }
      const first=await enqueuePurchaseReceiptRefresh(child,{availableAt:new Date(0)});
      assert.equal(first?.netsuiteOrderId,root);
      const [job]=await claimDueDelayedStatusRefreshJobs({workerId:'property-receipt'});
      for(let n=0;n<signals;n++) await enqueuePurchaseReceiptRefresh(n%2?root:child);
      assert.equal(await finishDelayedStatusRefreshAttempt({...job,outcome:'succeeded'}),true);
      const jobs=(await query('SELECT status,netsuite_order_id FROM netsuite_delayed_status_refresh_jobs ORDER BY id')).rows;
      assert.deepEqual(jobs.map(row=>row.status),['succeeded','pending']);assert(jobs.every(row=>Number(row.netsuite_order_id)===root));
      const received=full?quantity:quantity-1;
      await applyPurchaseReceiptProgress({netsuiteOrderId:root,lines:[{line_id:1,item_id:987771,item_name:'PROPERTY',item_type:'InvtPart',quantity,netsuite_received_qty:received,unit:'EA'}]});
      const saved=(await query('SELECT quantity,netsuite_received_qty FROM purchase_order_lines WHERE purchase_order_id=$1',[root])).rows[0];
      assert.equal(Number(saved?.quantity),quantity);assert.equal(Number(saved?.netsuite_received_qty),received);
      const header=(await query('SELECT receipt_status FROM purchase_orders WHERE netsuite_id=$1',[root])).rows[0];
      assert.equal(header.receipt_status,full?'received':received?'partial_received':'not_received');
      const summary=regularStockStatusSummary({workflowKind:'backorder',salesOrderRef:'OPEN-SO',status:'active',
        alreadyOrderedArrival:{status:full?'arrived':'arrival'},lines:[{id:1,supplyStatus:'already_ordered'}]});
      assert.equal(summary.status,full?'completed':'in_progress');
    },{rollback:true})),{seed:20261027,numRuns:35});
});
