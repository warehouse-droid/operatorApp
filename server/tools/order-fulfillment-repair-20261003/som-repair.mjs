import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {suiteql,fetchItemFulfillmentFromNetSuite} from '/app/src/netsuite.js';
import * as repository from '/app/src/operator-netsuite-posting-repository.js';
import {finalizeOperatorNetSuitePosting} from '/app/src/operator-netsuite-posting-finalizer.js';
import {lockConsolidatedLoadOrders} from '/app/src/consolidation-load-locks.js';
import {updateSalesOrderNetSuiteStatus} from '/app/src/order-sync-repository.js';
import {enqueueDispatchOrderCatalogRefresh} from '/app/src/dispatch-order-catalog-repository.js';
import {writeAudit} from '/app/src/auth-repository.js';
import {getDeliveryOrder} from '/app/src/delivery-repository.js';
import {verifySomEvidence} from './som-evidence.mjs';
const id=1033859,commandId='39221e63-f94a-4329-ae2d-fe9c55788b61';
const mode=process.env.SOM_REPAIR_MODE;assert(['snapshot','rehearse','apply','verify'].includes(mode));
const fetchOriginal=globalThis.fetch;let recordWrites=0;
globalThis.fetch=async(url,opts={})=>{if(new URL(url).pathname.includes('/record/v1/')&&(opts.method||'GET')!=='GET'){recordWrites++;throw Error('NetSuite writes forbidden');}return fetchOriginal(url,opts);};
async function snapshot(){return {order:(await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[id])).rows,
 lines:(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id',[id])).rows,
 command:await repository.getOperatorNetSuitePostingCommand(commandId),
 loads:(await query('SELECT * FROM operator_load_records WHERE order_id=$1 ORDER BY id',[id])).rows,
 audit:(await query('SELECT * FROM delivery_audit_log WHERE order_id=$1 ORDER BY id',[id])).rows};}
async function verify(){const o=await getDeliveryOrder(id,{includeNetSuiteClosed:true}),s=await snapshot();assert.equal(o.operator_status,'loaded');assert(!o.posting?.loadBlocked);assert.equal(s.command.status,'completed');assert.equal(s.command.activeClaims.length,0);assert.equal(s.loads.length,1);assert.equal(Number(s.lines[0].quantity),1);assert.equal(Number(s.lines[0].loaded_qty),1);assert.equal(s.lines[0].unit,'Yard');return {orderRef:'SOM06812',quantity:1,unit:'Yard',operatorStatus:o.operator_status,posting:o.posting,transactionRef:s.command.steps[0].netSuiteTransactionRef};}
try {
 const before=await snapshot();
 if(mode==='verify'){console.log(JSON.stringify({mode,verified:await verify()}));}
 else {
  const record=await fetchItemFulfillmentFromNetSuite(1033754);
  const sourceRows=(await suiteql("SELECT t.id,t.tranid,t.status,BUILTIN.DF(t.status) AS status_text,tl.uniquekey,tl.item,tl.quantity,tl.quantityshiprecv,tl.units FROM transaction t JOIN transactionline tl ON tl.transaction=t.id WHERE t.id=1033859 AND tl.mainline='F' AND tl.taxline='F' AND tl.item IS NOT NULL")).items;
  const history=(await suiteql("SELECT DISTINCT t.id,t.tranid,t.status FROM transaction t JOIN transactionline tl ON tl.transaction=t.id WHERE tl.createdfrom=1033859 AND t.type='ItemShip'")).items;
  const webhook=(await query("SELECT payload FROM netsuite_order_webhook_inbox WHERE id=10949 AND netsuite_order_id='1033859' AND status='succeeded'")).rows[0]?.payload;
  const remote={record,sourceRows,history,webhook};
  if(mode==='snapshot'){console.log(JSON.stringify({mode,before,remote}));}
  else {
   const result=await withTransaction(async()=>{
    await query("SET LOCAL lock_timeout='5s'");await query("SET LOCAL statement_timeout='30s'");
    await lockConsolidatedLoadOrders([id]);await query('SELECT id FROM operator_netsuite_posting_commands WHERE id=$1 FOR UPDATE',[commandId]);
    await query('SELECT netsuite_id FROM sales_orders WHERE netsuite_id=$1 FOR UPDATE',[id]);await query('SELECT id FROM sales_order_lines WHERE sales_order_id=$1 FOR UPDATE',[id]);
    const current=await snapshot();assert.deepEqual(current,before);
    if(current.command.status==='completed')return {alreadyApplied:true,verified:await verify()};
    assert.equal(current.command.status,'attention');assert.equal(current.loads.length,0);
    const proof=verifySomEvidence({...remote,command:current.command,localLines:current.lines});
    const updated=await query("UPDATE sales_order_lines SET quantity=1,packed_sales_qty=1,netsuite_committed_qty=CASE WHEN netsuite_committed_qty=1.3 THEN 1 ELSE netsuite_committed_qty END WHERE id=498743 AND quantity=1.3 AND packed_sales_qty=1.3 AND loaded_qty=0 RETURNING id");assert.equal(updated.rowCount,1);
    await repository.resumeOperatorNetSuitePostingCommand(commandId);
    const lease=await repository.claimOperatorNetSuitePostingCommand({commandId,workerId:'som-native-uom-repair-20261003',leaseSeconds:120});assert(lease);
    const stepId=current.command.steps[0].id;
    const attempt=await repository.startOperatorNetSuitePostingAttempt({commandId,stepId,leaseToken:lease.leaseToken});
    await repository.recordOperatorNetSuitePostingStepSuccess({commandId,stepId,leaseToken:lease.leaseToken,attemptNumber:attempt.attemptNumber,transactionId:1033754,transactionRef:'IF156257',recovered:true,response:{supportReconciliation:proof}});
    const command=await repository.getOperatorNetSuitePostingCommand(commandId);
    await repository.completeOperatorNetSuitePostingCommand({commandId,leaseToken:lease.leaseToken,result:{supportReconciliation:proof},finalize:()=>finalizeOperatorNetSuitePosting(command)});
    await updateSalesOrderNetSuiteStatus(id,{status:'F',statusText:sourceRows[0].status_text});
    await query("UPDATE sales_orders SET fulfillment_status='fulfilled',last_item_fulfillment_id=1033754,last_item_fulfillment_tranid='IF156257',fulfilled_at=$2 WHERE netsuite_id=$1",[id,record.createdDate]);
    await query("UPDATE operator_load_records SET response=response||jsonb_build_object('supportReconciliation',$2::jsonb) WHERE order_id=$1",[id,JSON.stringify(proof)]);
    await writeAudit({actorType:'system',source:'user-requested-incident-repair',action:'operator.native_sales_uom.reconciled',orderId:id,details:{...proof,commandId,originalInputHash:current.command.inputHash,netSuiteRecordWrites:0}});
    await enqueueDispatchOrderCatalogRefresh({orderRef:'SOM06812',orderType:'SO',source:'verified-native-uom-repair'});
    const after=await snapshot();for(const field of ['inputHash','inputSnapshot','photoRefs','actorOperatorId','requestId'])assert.deepEqual(after.command[field],current.command[field]);
    assert.equal(after.loads[0].line_snapshot.length,1);assert.equal(Number(after.lines[0].loaded_qty),1);
    return {proof,verified:await verify()};
   },{rollback:mode==='rehearse'});
   const after=await snapshot();if(mode==='rehearse')assert.deepEqual(after,before);assert.equal(recordWrites,0);
   console.log(JSON.stringify({mode,result,before,after,remote,recordWrites,rollbackVerified:mode==='rehearse'}));
  }
 }
}finally{await closeDb();}
