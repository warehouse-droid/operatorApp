// Maintenance reconciliation: NetSuite reads and local transactions only.
// The runner supplies reviewed bundle/plan constants and APPLY explicitly.
import {query,withTransaction,beginRollbackContext,closeDb} from '../../src/db.js';
import {fetchItemFulfillmentFromNetSuite,suiteqlAll} from '../../src/netsuite.js';
import {writeAudit} from '../../src/auth-repository.js';
import {resumeOperatorNetSuitePostingCommand,claimOperatorNetSuitePostingCommand,startOperatorNetSuitePostingAttempt,
 recordOperatorNetSuitePostingStepSuccess,completeOperatorNetSuitePostingCommand} from '../../src/operator-netsuite-posting-repository.js';
import {finalizeOperatorNetSuitePosting} from '../../src/operator-netsuite-posting-finalizer.js';
import {prepareSalesOrderAutoFulfillmentCandidate} from '../../src/sales-order-auto-fulfillment-repository.js';
import {verifyReviewedExisting} from './verify-reviewed-existing.mjs';
const actor='maintenance:netsuite-attention-20261003';
const reason='User requested queue resolution after verifying existing NetSuite IF/IR. Existing transactions verified; no NetSuite posting in this reconciliation.';
const liveRecords=new Map();
async function verifyAllExistingRecords() {
 const ids=[...new Set(PLAN.cases.map(c=>c.sourceId))];assert.ok(ids.every(Number.isSafeInteger));
 const liveLines=await suiteqlAll(`SELECT tl.transaction AS source_id,tl.id AS order_line,tl.uniquekey AS source_line_key,
  tl.item AS item_id,tl.quantity,tl.quantityshiprecv AS fulfilled_quantity,tl.units AS unit_id,
  tl.location AS location_id,uom.conversionrate AS conversion_rate
  FROM transactionline tl LEFT JOIN UnitsTypeUom uom ON uom.internalid=tl.units
  WHERE tl.transaction IN (${ids.join(',')}) AND tl.item IS NOT NULL AND tl.mainline='F' AND tl.taxline='F'`);
 for(const old of BUNDLE.sources.lines.filter(l=>ids.includes(Number(l.source_id)))) {
  const matches=liveLines.filter(l=>l.source_id===old.source_id&&l.source_line_key===old.source_line_key);
  assert.equal(matches.length,1,'Source line changed since review');
  for(const field of ['order_line','item_id','quantity','fulfilled_quantity','unit_id','location_id','conversion_rate'])
   assert.equal(String(matches[0][field]??''),String(old[field]??''),`Source ${old.source_id} line ${old.order_line} ${field} changed since review`);
 }
 const headers=await suiteqlAll(`SELECT id,tranid,status,BUILTIN.DF(status) AS status_text FROM transaction WHERE id IN (${ids.join(',')}) AND type='SalesOrd'`);
 for(const old of BUNDLE.sources.headers.filter(h=>ids.includes(Number(h.id)))) {
  const current=headers.find(h=>h.id===old.id);assert.ok(current);assert.equal(current.tranid,old.tranid);
  assert.ok(current.status===old.status||(['F','G'].includes(current.status)&&['F','G'].includes(old.status)),'Source fulfillment status changed since review');
 }
 BUNDLE.sources.headers=headers;BUNDLE.sources.at=new Date().toISOString();
 const frozen=new Map(BUNDLE.linked.results.map(r=>[r.id,r.record]));
 let cursor=0;const entries=[...frozen.entries()];
 await Promise.all(Array.from({length:3},async()=>{while(cursor<entries.length){const [id,old]=entries[cursor++];
  const current=await fetchItemFulfillmentFromNetSuite(id);
  assert.equal(current.lastModifiedDate,old.lastModifiedDate,`Existing IF ${id} changed since review`);
  assert.equal(current.tranId,old.tranId);assert.equal(current.createdFrom.id,old.createdFrom.id);
  liveRecords.set(id,current);
 }}));
}
async function checkExisting(entry) {
 const frozen=BUNDLE.remote.results.find(r=>r.id===entry.id)?.record;
 const record=liveRecords.get(entry.verified.id);assert.ok(record);
 assert.equal(record.lastModifiedDate,frozen.lastModifiedDate,'Remote IF changed since review');
 const step=entry.queue==='native'?BUNDLE.inventory.native.find(c=>c.id===entry.id).steps[0]:entry.reviewed;
 const extras=entry.adjustments.filter(a=>a.kind==='confirmed_source_noninventory').map(a=>a.sourceLineKey);
 // Re-run the exact reviewed verification against a fresh REST record.
 const proof=verifyReviewedExisting({step:entry.queue==='native'?step:entry.reviewed,
  record:{...record,transactionType:'IF'},sourceLines:BUNDLE.sources.lines,
  allowLegacyBase:entry.queue==='native',confirmedExtraLines:extras});
 assert.equal(proof.verified.id,entry.verified.id);return record;
}
async function updateHeader(entry) {
 const header=BUNDLE.sources.headers.find(h=>Number(h.id)===entry.sourceId);
 if(!header||!['F','G'].includes(header.status))return;
 const before=(await query('SELECT status,status_text,fulfillment_status FROM sales_orders WHERE netsuite_id=$1 FOR UPDATE',[entry.sourceId])).rows[0];
 await query(`UPDATE sales_orders SET status=$2,status_text=$3,fulfillment_status='fulfilled' WHERE netsuite_id=$1`,[entry.sourceId,header.status,header.status_text]);
 return before;
}
async function native(entry,record) {
 const row=(await query('SELECT * FROM operator_netsuite_posting_commands WHERE id=$1 FOR UPDATE',[entry.id])).rows[0];
 assert.equal(row.status,'attention');assert.equal(row.input_hash,entry.inputHash);
 assert.equal(row.updated_at.toISOString(),entry.expectedUpdatedAt);
 const unitCorrections=[];
 for(const change of entry.adjustments.filter(a=>a.kind==='historical_base_units')) {
  const local=(await query(`SELECT * FROM sales_order_lines WHERE sales_order_id=$1 AND line_id=$2 FOR UPDATE`,[entry.sourceId,change.sourceLineKey])).rows;
  assert.equal(local.length,1);const line=local[0];assert.ok(same(line.quantity,change.originalQuantity));
  assert.ok(Number(line.loaded_qty||0)<=Number(line.quantity));assert.ok(Number(line.packed_sales_qty||0)<=Number(line.quantity));
  await query(`UPDATE sales_order_lines SET quantity=$2,loaded_qty=loaded_qty/$3,packed_sales_qty=packed_sales_qty/$3 WHERE id=$1`,[line.id,change.quantity,change.factor]);
  unitCorrections.push({lineId:line.id,before:{quantity:line.quantity,loaded:line.loaded_qty,packed:line.packed_sales_qty},...change});
 }
 await resumeOperatorNetSuitePostingCommand(entry.id);
 const command=await claimOperatorNetSuitePostingCommand({commandId:entry.id,workerId:actor,leaseSeconds:180});assert.ok(command);
 assert.equal(command.steps.length,1);const step=command.steps[0];
 const attempt=await startOperatorNetSuitePostingAttempt({commandId:entry.id,stepId:step.id,leaseToken:command.leaseToken});
 command.steps[0]=await recordOperatorNetSuitePostingStepSuccess({commandId:entry.id,stepId:step.id,leaseToken:command.leaseToken,
  attemptNumber:attempt.attemptNumber,transactionId:entry.verified.id,transactionRef:entry.verified.transactionRef,recovered:true,
  response:{id:entry.verified.id,tranId:entry.verified.transactionRef,externalId:record.externalId,
   maintenanceVerification:{sourceEvidenceAt:BUNDLE.sources.at,adjustments:entry.adjustments}}});
 const result=await completeOperatorNetSuitePostingCommand({commandId:entry.id,leaseToken:command.leaseToken,
  result:{recovered:true,maintenanceVerification:entry.adjustments},finalize:async()=>{
   const state=(await query(`SELECT count(*) FILTER(WHERE COALESCE(loaded_qty,0)<quantity-0.000001)::int AS remaining
    FROM sales_order_lines WHERE sales_order_id=$1 AND item_type IN ('InvtPart','NonInvtPart') AND quantity>0 AND netsuite_active`,[entry.sourceId])).rows[0];
   if(state.remaining!==0)return finalizeOperatorNetSuitePosting(command);
   // A legacy local save already contains the complete loaded quantity. Attach
   // the verified transaction without recording another physical load.
   await query(`UPDATE sales_order_lines SET packed_sales_qty=0,packed_pallet_qty=0,packed_layer_qty=0,packed_piece_qty=0,
     packed_section_qty=0,confirmed=false,confirmed_at=NULL WHERE sales_order_id=$1`,[entry.sourceId]);
   await query(`UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='Loaded' WHERE netsuite_id=$1`,[entry.sourceId]);
   return {alreadyLoaded:true,transactionId:entry.verified.id,transactionRef:entry.verified.transactionRef};
  }});
 const previousHeader=await updateHeader(entry);
 await writeAudit({actorType:'system',source:'admin',action:'operator_netsuite_posting.verified_existing_reconciled',orderId:entry.sourceId,
  details:{actor,reason,commandId:entry.id,transaction:entry.verified,adjustments:entry.adjustments,unitCorrections,previousHeader}});
 return {reference:entry.reference,status:result.status,transaction:entry.verified.transactionRef};
}
async function sales(entry) {
 const row=(await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1 FOR UPDATE',[entry.id])).rows[0];
 assert.equal(row.status,entry.expectedStatus);assert.equal(row.updated_at.toISOString(),entry.expectedUpdatedAt);
 assert.equal(row.snapshot_hash,entry.snapshotHash);assert.equal(row.lease_token,null);
 const firstAlias=['SOA09223-S1','SOA09143-S1','SOA09140-S1'].includes(entry.reference);
 const status=entry.status==='recover_existing'?'completed':entry.status==='reconcile_fulfilled'?'reconciled':entry.status==='skip_nonfulfillable'?'skipped':'discovered';
 if(entry.status==='review_remaining'&&!firstAlias)return {reference:entry.reference,status:'review_remaining',remaining:entry.remaining};
 if(status==='discovered')assert.equal(row.attempt_count,0,'Unattempted work only');
 await query(`UPDATE dispatch_sales_order_if_candidates SET status=$2,source_sales_order_id=$3,source_sales_order_ref=$4,
  netsuite_transaction_id=COALESCE($5,netsuite_transaction_id),netsuite_transaction_ref=COALESCE($6,netsuite_transaction_ref),
  last_error=NULL,completed_at=CASE WHEN $2 IN ('completed','reconciled') THEN now() END,updated_at=now(),
  result=COALESCE(result,'{}')||jsonb_build_object('maintenanceVerification',$7::jsonb)
  WHERE id=$1`,[entry.id,status,entry.sourceId,entry.sourceRef||BUNDLE.sources.headers.find(h=>Number(h.id)===entry.sourceId)?.tranid,
  entry.verified?.id||null,entry.verified?.transactionRef||null,JSON.stringify({verifiedAt:new Date().toISOString(),sourceEvidenceAt:BUNDLE.sources.at,
   adjustments:entry.adjustments,transactions:entry.remoteRecords||[entry.verified],postingAttempted:false})]);
 if(['completed','reconciled','skipped'].includes(status)) {
  await query('UPDATE dispatch_sales_order_if_line_claims SET active=false,released_at=now() WHERE candidate_id=$1 AND active',[entry.id]);
  await updateHeader(entry);
 }
 await query(`INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,actor_id,reason,details)
  VALUES($1,'verified_existing_maintenance',$2,$3,$4::jsonb)`,[entry.id,actor,reason,JSON.stringify({beforeStatus:row.status,status,
   sourceEvidenceAt:BUNDLE.sources.at,verified:entry.verified,records:entry.remoteRecords,adjustments:entry.adjustments,remaining:entry.remaining})]);
 const after=status==='discovered'?await prepareSalesOrderAutoFulfillmentCandidate(entry.id):{status};
 if(status==='discovered')assert.equal(after.status,'waiting_evidence','Restored work must remain blocked on missing evidence during maintenance');
 return {reference:entry.reference,status:after.status,transaction:entry.verified?.transactionRef,reason:after.lastError};
}
const results=[];
try {
 await verifyAllExistingRecords();
 for(const entry of PLAN.cases) {
  const record=entry.status==='recover_existing'?await checkExisting(entry):null;
  const operation=()=>entry.queue==='native'?native(entry,record):sales(entry);
  try {
   if(APPLY)results.push(await withTransaction(operation));
   else {const rollback=await beginRollbackContext();try{results.push(await rollback.run(operation));}finally{await rollback.rollback();}}
  }catch(error){results.push({reference:entry.reference,error:error.message});if(APPLY)throw error;}
 }
 console.log(JSON.stringify({apply:APPLY,at:new Date().toISOString(),netSuitePosts:0,results},null,2));
}finally{await closeDb();}
