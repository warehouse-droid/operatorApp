// Bundled after proof.mjs by run.py. The only external operations here are reads.
import {query,withTransaction,beginRollbackContext,closeDb} from './src/db.js';
import {suiteqlAll,fetchItemFulfillmentFromNetSuite} from './src/netsuite.js';
import {writeAudit} from './src/auth-repository.js';
import {updateSalesOrderNetSuiteStatus,updateTransferOrderNetSuiteStatus} from './src/order-sync-repository.js';
import {locallyReopenedSalesOrderIds} from './src/local-sales-order-reopen.js';
import {resumeOperatorNetSuitePostingCommand,claimOperatorNetSuitePostingCommand,startOperatorNetSuitePostingAttempt,
  recordOperatorNetSuitePostingStepSuccess,completeOperatorNetSuitePostingCommand} from './src/operator-netsuite-posting-repository.js';
const actor='maintenance:netsuite-queue-resolution-20261021';
const reason='User requested resolving verification/fulfillment queues and updating local status where NetSuite is already complete. Existing transactions verified; no NetSuite write.';
let headers=BUNDLE.headers.headers,lines=BUNDLE['source-lines'].lines,linked=BUNDLE['linked-transactions'].linked;
const local=BUNDLE['local-evidence'].local,records=BUNDLE.records;
let evidenceAt=BUNDLE.headers.at;
const emit=data=>console.log(JSON.stringify({at:new Date().toISOString(),...data}));
const sourceHeader=c=>headers.find(h=>h.type==='SalesOrd'&&(Number(h.id)===Number(c.sourceSalesOrderId)
  ||h.tranid===(c.sourceSalesOrderRef||c.dispatchOrderRef.replace(/-S\d+$/i,''))));

async function refreshEvidence() {
  const ids=headers.map(h=>Number(h.id));assert.ok(ids.every(n=>Number.isSafeInteger(n)&&n>0));
  headers=await suiteqlAll(`SELECT id,tranid,type,status,BUILTIN.DF(status) AS status_text,lastmodifieddate
    FROM transaction WHERE id IN (${ids.join(',')})`);
  lines=await suiteqlAll(`SELECT tl.transaction AS source_id,tl.id AS order_line,tl.uniquekey AS source_line_key,
    tl.item AS item_id,i.itemtype AS item_type,i.isfulfillable AS is_fulfillable,BUILTIN.DF(tl.item) AS item_name,
    tl.quantity,tl.quantityshiprecv AS fulfilled_quantity,tl.isclosed AS is_closed,tl.donotprintline AS do_not_print_line,
    tl.units AS unit_id,BUILTIN.DF(tl.units) AS unit,uom.conversionrate AS conversion_rate,
    tl.location AS location_id,BUILTIN.DF(tl.location) AS location FROM transactionline tl
    LEFT JOIN item i ON i.id=tl.item LEFT JOIN UnitsTypeUom uom ON uom.internalid=tl.units
    WHERE tl.transaction IN (${ids.join(',')}) AND tl.item IS NOT NULL AND tl.mainline='F' AND (tl.taxline='F' OR tl.taxline IS NULL)
    ORDER BY tl.transaction,tl.id`);
  linked=await suiteqlAll(`SELECT link.previousdoc AS source_id,link.previousline AS source_line,
    t.id,t.tranid,t.type,t.status,BUILTIN.DF(t.status) AS status_text,t.lastmodifieddate,
    tl.id AS transaction_line,tl.item AS item_id,tl.quantity,tl.units AS unit_id,BUILTIN.DF(tl.units) AS unit,
    uom.conversionrate AS conversion_rate,tl.location AS location_id FROM NextTransactionLineLink link
    JOIN transaction t ON t.id=link.nextdoc JOIN transactionline tl ON tl.transaction=link.nextdoc AND tl.id=link.nextline
    LEFT JOIN UnitsTypeUom uom ON uom.internalid=tl.units
    WHERE link.previousdoc IN (${ids.join(',')}) AND t.type IN ('ItemShip','ItemRcpt') AND tl.item IS NOT NULL
    AND (tl.taxline='F' OR tl.taxline IS NULL) ORDER BY link.previousdoc,t.id,tl.id`);
  for(const input of records) {
    const current=await fetchItemFulfillmentFromNetSuite(input.record.id);
    assert.equal(current.lastModifiedDate,input.record.lastModifiedDate,'Reviewed IF changed');
    assert.equal(current.tranId,input.record.tranId);assert.equal(current.externalId,input.record.externalId);
    input.record=current;emit({event:'refreshed-existing',reference:input.ref,transaction:current.tranId});
  }
  evidenceAt=new Date().toISOString();
  emit({event:'fresh-remote-evidence',headers,lines,linked});
}

function plan() {
  const cases=[],blocked=[];
  for(const input of records) {
    try {input.proof=reviewExistingIf(input,lines,local);}
    catch(error) {input.proofError=error.message;blocked.push({queue:input.queue,reference:input.ref,error:error.message});}
  }
  for(const c of BUNDLE.inventory.native) {
    const input=records.find(x=>x.queue==='native'&&x.id===c.id);
    if(!input?.proof)continue;
    const header=headers.find(h=>Number(h.id)===Number(input.step.sourceNetSuiteId));
    assert.ok(['F','G'].includes(header.status));
    cases.push({queue:'native',id:c.id,reference:input.ref,original:c,header,input});
  }
  for(const c of BUNDLE.inventory.sales) {
    const header=sourceHeader(c);
    if(header&&['SOA06143-S1','SOA08854-S1'].includes(c.dispatchOrderRef)) {
      try {
        const partialProof=reviewCompletedSplit(c,header,lines,linked,BUNDLE.remaining);
        cases.push({queue:'sales',id:c.id,reference:c.dispatchOrderRef,original:c,header,partialProof});
      }catch(error){blocked.push({queue:'sales',reference:c.dispatchOrderRef,id:c.id,error:error.message});}
      continue;
    }
    if(!header||!['F','G'].includes(header.status)) {blocked.push({queue:'sales',reference:c.dispatchOrderRef,id:c.id,sourceStatus:header?.status,error:c.lastError});continue;}
    const input=records.find(x=>x.queue==='sales'&&x.id===c.id);
    if(c.status==='uncertain'&&!input?.proof)continue;
    cases.push({queue:'sales',id:c.id,reference:c.dispatchOrderRef,original:c,header,input});
  }
  for(const job of BUNDLE['local-evidence'].jobs) {
    try {
      const header=one(headers.filter(h=>Number(h.id)===Number(job.local_to_id)),'TO header');
      const proof=reviewTransfer(job,header,lines,linked);
      cases.push({queue:'transfer',id:job.id,reference:job.order_ref,original:job,header,proof});
    } catch(error) {blocked.push({queue:'transfer',reference:job.order_ref,id:job.id,error:error.message});}
  }
  return {cases,blocked};
}

async function syncSalesHeader(entry) {
  if(entry.partialProof) {
    const {localOrderId,splitRef,target,verified}=entry.partialProof;
    const split=(await query('SELECT * FROM dispatch_global_order_splits WHERE split_ref=$1 FOR SHARE',[splitRef])).rows[0];
    assert.equal(split.active,true);assert.deepEqual(split.full_order,BUNDLE.remaining.splits.find(s=>s.split_ref===splitRef).full_order);
    const previous=(await query('SELECT netsuite_id,tranid,status,status_text,fulfillment_status FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) FOR UPDATE',
      [[localOrderId,Number(entry.header.id)]])).rows;
    await updateSalesOrderNetSuiteStatus(entry.header.id,{status:entry.header.status,statusText:entry.header.status_text});
    await query("UPDATE sales_orders SET fulfillment_status='fulfilled',operator_status='loaded',local_yard_order_status='loaded',last_item_fulfillment_id=$2,status_updated_at=now() WHERE netsuite_id=$1",
      [localOrderId,verified.id]);
    for(const line of target) {
      const updated=await query(`UPDATE sales_order_lines SET loaded_qty=quantity,loaded_uom=unit WHERE id=$1 AND sales_order_id=$2 AND ABS(quantity-$3)<0.000001 RETURNING id`,
        [line.localLineId,localOrderId,line.quantity]);assert.equal(updated.rowCount,1);
    }
    return previous;
  }
  const siblings=(await query(`SELECT netsuite_id,tranid,status,status_text,operator_status,local_yard_order_status,fulfillment_status
    FROM sales_orders WHERE netsuite_id=$1 OR tranid ~ ('^'||$2||'-S[0-9]+$') FOR UPDATE`,[entry.header.id,entry.header.tranid])).rows;
  assert.equal((await locallyReopenedSalesOrderIds(siblings.map(o=>o.netsuite_id))).size,0,'An intentional local reopen requires separate review');
  for(const order of siblings) {
    await updateSalesOrderNetSuiteStatus(order.netsuite_id,{status:entry.header.status,statusText:entry.header.status_text});
    await query("UPDATE sales_orders SET fulfillment_status='fulfilled' WHERE netsuite_id=$1",[order.netsuite_id]);
  }
  return siblings;
}

async function syncNativeProgress(entry) {
  // Reconcile current quantities to authoritative completed accounting; do not
  // invent an Operator load record or replay an old physical load.
  const current=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 FOR UPDATE',[entry.header.id])).rows;
  const changes=[];
  for(const row of current.filter(r=>r.netsuite_active&&Number(r.quantity)>0&&['InvtPart','NonInvtPart'].includes(r.item_type))) {
    const source=one(lines.filter(l=>Number(l.source_id)===Number(entry.header.id)&&String(l.source_line_key)===String(row.line_id)),'Native local stable source key');
    assert.equal(Number(row.item_id),Number(source.item_id));
    assert.equal(String(row.unit||'').toUpperCase(),String(source.unit||'').toUpperCase());
    assert.ok(same(row.quantity,quantity(source)),'Canonical and NetSuite ordered quantities match');
    assert.ok(Number(source.fulfilled_quantity)/factor(source)+0.000001>=Number(row.quantity),'NetSuite confirms the full local quantity');
    assert.ok(Number(row.loaded_qty||0)<=Number(row.quantity)+0.000001);
    changes.push({id:row.id,before:{loaded:row.loaded_qty,packed:row.packed_sales_qty},loaded:Number(row.quantity),sourceLineKey:String(source.source_line_key)});
    await query(`UPDATE sales_order_lines SET loaded_qty=quantity,loaded_uom=COALESCE(NULLIF(unit,''),loaded_uom),
      packed_sales_qty=0,packed_pallet_qty=0,packed_layer_qty=0,packed_piece_qty=0,packed_section_qty=0,confirmed=false,confirmed_at=NULL WHERE id=$1`,[row.id]);
  }
  await query(`UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='loaded',last_item_fulfillment_id=$2,
    status_updated_at=now() WHERE netsuite_id=$1`,[entry.header.id,entry.input.proof.verified.id]);
  return {reconciledFromNetSuite:true,transaction:entry.input.proof.verified,changes};
}

async function native(entry) {
  const row=(await query('SELECT * FROM operator_netsuite_posting_commands WHERE id=$1 FOR UPDATE',[entry.id])).rows[0];
  assert.equal(row.status,'attention');assert.equal(row.input_hash,entry.original.inputHash);assert.equal(row.lease_token,null);
  assert.equal(row.updated_at.toISOString(),entry.original.updatedAt);
  // Extra physical evidence must still be the same immutable source at apply time.
  for(const adjustment of entry.input.proof.adjustments.filter(a=>a.operatorLoadRecordId)) {
    const saved=(await query('SELECT line_snapshot FROM operator_load_records WHERE id=$1 AND order_id=$2',[adjustment.operatorLoadRecordId,entry.header.id])).rows[0];
    const old=local.find(o=>Number(o.netsuite_id)===Number(entry.header.id)).loads.find(r=>r.id===adjustment.operatorLoadRecordId);
    assert.deepEqual(saved.line_snapshot,old.lines);
  }
  await resumeOperatorNetSuitePostingCommand(entry.id);
  const command=await claimOperatorNetSuitePostingCommand({commandId:entry.id,workerId:actor,leaseSeconds:180});assert.ok(command);
  assert.equal(command.steps.length,1);const step=command.steps[0];
  assert.deepEqual(step.payload,entry.input.step.payload);assert.deepEqual(step.lineSnapshot,entry.input.step.lineSnapshot);
  const attempt=await startOperatorNetSuitePostingAttempt({commandId:entry.id,stepId:step.id,leaseToken:command.leaseToken});
  const {verified,adjustments}=entry.input.proof;
  command.steps[0]=await recordOperatorNetSuitePostingStepSuccess({commandId:entry.id,stepId:step.id,leaseToken:command.leaseToken,
    attemptNumber:attempt.attemptNumber,transactionId:verified.id,transactionRef:verified.transactionRef,recovered:true,
    response:{id:verified.id,tranId:verified.transactionRef,externalId:entry.input.record.externalId,
      maintenanceVerification:{evidenceAt,adjustments,postingAttempted:false}}});
  const result=await completeOperatorNetSuitePostingCommand({commandId:entry.id,leaseToken:command.leaseToken,
    result:{recovered:true,maintenanceVerification:{evidenceAt,adjustments}},finalize:()=>syncNativeProgress(entry)});
  const previousHeader=await syncSalesHeader(entry);
  await writeAudit({actorType:'system',source:'admin',action:'operator_netsuite_posting.verified_existing_reconciled',orderId:entry.header.id,
    details:{actor,reason,commandId:entry.id,verified,adjustments,evidenceAt,previousHeader,localResult:result.result}});
  return {status:result.status,transaction:verified.transactionRef};
}

async function sales(entry) {
  const row=(await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1 FOR UPDATE',[entry.id])).rows[0];
  assert.equal(row.status,entry.original.status);assert.equal(row.snapshot_hash,entry.original.snapshotHash);
  assert.equal(row.payload_hash,entry.original.payloadHash);assert.equal(row.lease_token,null);
  assert.equal(String(row.completion_event_id),String(entry.original.completionEventId));
  const verified=entry.partialProof?.verified||entry.input?.proof.verified,status=verified?'completed':'reconciled';
  const transactions=[...new Map(linked.filter(l=>Number(l.source_id)===Number(entry.header.id)&&l.type==='ItemShip')
    .map(l=>[Number(l.id),{id:Number(l.id),tranid:l.tranid}])).values()];
  const nonfulfillable=lines.filter(l=>Number(l.source_id)===Number(entry.header.id));
  const noFulfillmentRequired=nonfulfillable.length>0&&nonfulfillable.every(l=>l.is_fulfillable==='F');
  assert.ok(transactions.length||noFulfillmentRequired,'Completed SO must have linked IF evidence or exclusively nonfulfillable lines');
  const proof={evidenceAt,header:entry.header,transactions,verified,adjustments:entry.input?.proof.adjustments,
    partialSplit:entry.partialProof,noFulfillmentRequired,postingAttempted:false};
  await query(`UPDATE dispatch_sales_order_if_candidates SET status=$2,source_sales_order_id=$3,source_sales_order_ref=$4,
    netsuite_transaction_id=COALESCE($5,netsuite_transaction_id),netsuite_transaction_ref=COALESCE($6,netsuite_transaction_ref),
    last_error=NULL,completed_at=now(),updated_at=now(),result=COALESCE(result,'{}')||jsonb_build_object('maintenanceVerification',$7::jsonb)
    WHERE id=$1`,[entry.id,status,entry.header.id,entry.header.tranid,verified?.id||null,verified?.transactionRef||null,JSON.stringify(proof)]);
  await query('UPDATE dispatch_sales_order_if_line_claims SET active=false,released_at=now() WHERE candidate_id=$1 AND active',[entry.id]);
  const previousHeader=await syncSalesHeader(entry);
  await query(`INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,actor_id,reason,details)
    VALUES($1,'verified_existing_maintenance',$2,$3,$4::jsonb)`,[entry.id,actor,reason,JSON.stringify({beforeStatus:row.status,status,...proof,previousHeader})]);
  return {status,transaction:verified?.transactionRef};
}

async function transfer(entry) {
  const row=(await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1 FOR UPDATE',[entry.id])).rows[0];
  assert.equal(row.status,entry.original.status);assert.equal(row.command_id,null);assert.deepEqual(row.snapshot,entry.original.snapshot);
  assert.equal(row.operator_record_id,entry.original.operator_record_id);
  const proof={...entry.proof,maintenanceVerification:{evidenceAt,header:entry.header,postingAttempted:false}};
  if(row.transaction_type==='IF') {
    const updated=await query(`UPDATE operator_load_records SET response=COALESCE(response,'{}')||jsonb_build_object('operatorNetSuitePosting',$2::jsonb)
      WHERE id=$1 AND order_id=$3 AND order_family='transfer_order' AND load_type='transfer_order_load' RETURNING id`,
      [row.operator_record_id,JSON.stringify(proof),row.local_to_id]);assert.equal(updated.rowCount,1);
  }else{
    assert.equal(entry.proof.transactions.length,1);const receipt=entry.proof.transactions[0];
    const existing=(await query('SELECT item_receipt_id,receipt_status FROM receiving_receipt_records WHERE id=$1 AND order_id=$2 FOR UPDATE',[row.operator_record_id,row.local_to_id])).rows[0];
    assert.ok(existing);assert.ok(!existing.item_receipt_id||Number(existing.item_receipt_id)===receipt.transactionId);
    await query(`UPDATE receiving_receipt_records SET item_receipt_id=$2,item_receipt_tranid=$3,
      response=COALESCE(response,'{}')||jsonb_build_object('operatorNetSuitePosting',$4::jsonb) WHERE id=$1`,
      [row.operator_record_id,receipt.transactionId,receipt.transactionRef,JSON.stringify(proof)]);
    await query('UPDATE transfer_orders SET last_item_receipt_id=$2,last_item_receipt_tranid=$3 WHERE netsuite_id=$1',
      [row.local_to_id,receipt.transactionId,receipt.transactionRef]);
  }
  await query("UPDATE transfer_order_posting_jobs SET status='completed',last_error=NULL,result=$2::jsonb,updated_at=now() WHERE id=$1",[entry.id,JSON.stringify(proof)]);
  const previousHeader=(await query('SELECT status,status_text FROM transfer_orders WHERE netsuite_id=$1 FOR UPDATE',[row.local_to_id])).rows[0];
  await updateTransferOrderNetSuiteStatus(row.local_to_id,{status:entry.header.status,statusText:entry.header.status_text});
  await writeAudit({actorType:'system',source:'admin',action:'transfer_posting.verified_existing_reconciled',orderId:row.local_to_id,
    details:{actor,reason,jobId:entry.id,previousStatus:row.status,previousHeader,...proof}});
  return {status:'completed',transactions:entry.proof.transactions.map(t=>t.transactionRef)};
}

try {
  if(MODE!=='review')await refreshEvidence();
  const reviewed=plan();
  emit({event:'plan',cases:reviewed.cases.map(e=>({queue:e.queue,id:e.id,reference:e.reference,proof:e.input?.proof||e.proof})),blocked:reviewed.blocked});
  const results=[];
  if(MODE!=='review')for(const entry of reviewed.cases) {
    const operation=()=>({native,sales,transfer}[entry.queue])(entry);
    try {
      let result;
      if(MODE==='apply')result=await withTransaction(operation);
      else {const context=await beginRollbackContext();try{result=await context.run(operation);}finally{await context.rollback();}}
      const row={queue:entry.queue,id:entry.id,reference:entry.reference,...result};results.push(row);emit({event:'result',...row});
    }catch(error){const row={queue:entry.queue,reference:entry.reference,error:error.message};results.push(row);emit({event:'error',...row});if(MODE==='apply')throw error;}
  }
  emit({event:'summary',mode:MODE,netSuitePosts:0,planned:reviewed.cases.length,completed:results.filter(r=>!r.error).length,
    errors:results.filter(r=>r.error),blocked:reviewed.blocked});
}finally{await closeDb();}
