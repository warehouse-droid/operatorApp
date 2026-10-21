import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {submitRegularStockRequest,editRegularStockRequest,decideRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import {getScmStockRequest,listScmStockRequests} from '../../../src/stock-request-repository.js';
import {addPurchaseStockProposals} from '../../../src/regular-stock-purchase-service.js';
import {reconcilePurchaseStockAllocations} from '../../../src/regular-stock-purchase-repository.js';
import {moveStockingLineToWaitlist} from '../../../src/regular-stock-waitlist-transition.js';
import {repairStockingResolutionScope} from '../../../tools/stocking-line-actions-20261006/repair.mjs';

const canonical=value=>JSON.parse(JSON.stringify(value));
const run=randomUUID(),actors={},tokens={},nativeFetch=globalThis.fetch,itemId=9800000000221,vendorId=910221,poId=itemId;
const poRef='LINE-PO-'+run,password=run+'-Line-A1!';
const dependencies={refreshAvailability:async()=>{},loadPolicies:async()=>[],loadPurchaseStock:async()=>({available:1000,onHand:1000}),
  loadPurchasePolicy:async()=>({item_id:itemId,item_name:'Line material',stock_unit:'EA',to_plt:100,pallet_weight_lbs:1000,
    vendor_id:vendorId,vendor:'Line vendor',vendor_yard_id:vendorId,vendor_yard:'Line source',plant:'Line source'})};
let server,base,outbound=0;
async function http(path,role,body){
  const response=await nativeFetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(role?{Authorization:`Bearer ${tokens[role]}`} : {}),
    ...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
const request=(type='purchase',count=3)=>submitRegularStockRequest({deliveryMethod:'stocking',stockingType:type,destinationLocationId:28,
  lines:Array.from({length:count},(_,index)=>({itemId,...(type==='transfer'?{sourceLocationId:1}:{}),pieces:20+index}))},
  {operatorId:actors.sales.id,authorizedDestinationLocationIds:[26],allowOverAvailability:true},dependencies);
const send=(r,line,role='scm',extra={})=>http(`/api/${role==='sales'||role==='peer'||role==='other'?'sales':'scm'}/stock-requests/${r.id}/reply`,role,
  {lineId:line.id,message:'Instructions for this material.\n<script>text</script>',expectedRevision:r.revision,...extra});
const resolve=(r,line,extra={},role='scm')=>http(`/api/scm/stock-requests/${r.id}/resolve`,role,
  {lineId:line.id,purchaseOrderRef:poRef,eta:'2026-10-15',expectedRevision:r.revision,...extra});
const snapshot=async id=>(await query(`SELECT r.*, (SELECT jsonb_agg(l ORDER BY l.id) FROM sales_stock_request_lines l WHERE l.request_id=r.id) AS lines,
  (SELECT jsonb_agg(e ORDER BY e.id) FROM sales_stock_request_events e WHERE e.request_id=r.id) AS events FROM sales_stock_requests r WHERE r.id=$1`,[id])).rows[0];
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await query("INSERT INTO dispatch_vendor_yards(id,vendor,yard) VALUES($1,'Line vendor','Line source') ON CONFLICT DO NOTHING",[vendorId]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight,vendor_id,vendor) VALUES($1,'Line material','EA',1,100,10,$2,'Line vendor') ON CONFLICT DO NOTHING",[itemId,vendorId]);
  for(const yard of [1,28,26])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000,1000,now()) ON CONFLICT DO NOTHING",[itemId,yard,String(yard)]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,memo,foreign_total) VALUES($1,$2,true,'Preserve PO',123) ON CONFLICT DO NOTHING",[poId,poRef]);
  server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));base=`http://127.0.0.1:${server.address().port}`;
  for(const [key,role,yards] of [['sales','sales',[26]],['peer','sales',[26]],['other','sales',[15]],['scm','scm',[]],['driver','dispatcher',[]]]){
    const username=`line-${key}-${run}`;await createOperator({username,displayName:username,password,role,roles:[role],yardLocationIds:yards});
    actors[key]=(await query('SELECT id FROM operators WHERE username=$1',[username])).rows[0];tokens[key]=(await http('/api/auth/login',null,{username,password})).body.token;
  }
  globalThis.fetch=async()=>{outbound++;throw Error('External service calls are forbidden in these tests');};
});
after(async()=>{globalThis.fetch=nativeFetch;await new Promise(done=>server.close(done));await closeDb();});

test('SCM and Sales conversation belongs to one material and cannot authorize replies on another',async()=>{
  for(const type of ['transfer','purchase']){
    const r=await request(type),[a,b]=r.lines,before=await snapshot(r.id);
    const result=await send(r,a);assert.equal(result.status,200);const updated=result.body;
    assert.equal(updated.lines[0].replyStatus,'pending_update');assert.equal(updated.lines[1].replyStatus,null);
    assert.deepEqual(updated.lines[1],canonical(r.lines[1]));assert.equal(updated.status,r.status);assert.equal(updated.revision,r.revision+1);
    const event=updated.events.find(e=>e.eventType==='regular_scm_reply');assert.equal(event.requestLineId,a.id);assert.equal(event.details.lineId,a.id);
    assert.equal((await send(updated,b,'sales')).status,409);
    const replied=await send(updated,a,'sales',{message:'Confirmed',salesOrderRef:'SO-REF'});assert.equal(replied.status,200);
    assert.equal(replied.body.lines[0].replyStatus,'pending_scm');assert.equal(replied.body.lines[0].reply.salesOrderRef,'SO-REF');
    assert.deepEqual(replied.body.lines[1],canonical(r.lines[1]));assert.deepEqual((await snapshot(r.id)).lines,before.lines);
  }
});
test('a scoped instruction with an archived line foreign key still cannot authorize another material',async()=>{
  const r=await request(),[a,b]=r.lines,updated=(await send(r,a)).body;
  await query("UPDATE sales_stock_request_events SET request_line_id=NULL WHERE request_id=$1 AND event_type='regular_scm_reply'",[r.id]);
  const before=await snapshot(r.id);assert.equal((await send(updated,b,'sales')).status,409);assert.deepEqual(await snapshot(r.id),before);
  assert.equal((await send(updated,a,'sales')).status,200);
});
test('Sales edits preserve existing material conversations and removing a material does not authorize another thread',async()=>{
  let r=await request('transfer');
  const edit=lines=>editRegularStockRequest(r.id,{expectedRevision:r.revision,deliveryMethod:'stocking',stockingType:'transfer',destinationLocationId:28,lines},
    {operatorId:actors.sales.id,authorizedDestinationLocationIds:[26],allowOverAvailability:true},dependencies);
  const inputs=()=>r.lines.map(line=>({id:line.id,itemId:line.itemId,sourceLocationId:line.sourceLocationId,pieces:line.pieces}));
  const original=r.lines.map(line=>[line.id,line.salesQty]);r=await edit(inputs());assert.deepEqual(r.lines.map(line=>[line.id,line.salesQty]),original);
  const [a,b,c]=r.lines;r=(await send(r,a)).body;r=(await send(r,b)).body;r=(await send(r,a,'sales',{message:'A confirmed'})).body;
  const states=canonical(r.regular.stockingLines),changed=inputs();changed[0].pieces+=5;
  r=await edit(changed);assert.deepEqual(r.regular.stockingLines,states);assert.equal(r.regular.replyStatus,'pending_scm');
  assert.equal(r.lines[0].salesQty,a.salesQty+5);assert.equal(r.lines[1].replyStatus,'pending_update');
  const events=canonical((await snapshot(r.id)).events);
  r=await edit(inputs().filter(line=>line.id!==a.id));
  assert.equal(r.lines.length,2);assert.equal(r.regular.stockingLines[a.id],undefined);assert.deepEqual(r.regular.stockingLines[b.id],states[b.id]);
  assert.equal(r.regular.replyStatus,'pending_update');assert.equal((await send(r,c,'sales')).status,409);assert.equal((await send(r,b,'sales')).status,200);
  const after=canonical((await snapshot(r.id)).events);
  for(const event of events){const archived={...event,request_line_id:event.request_line_id===a.id?null:event.request_line_id};assert.ok(after.some(row=>JSON.stringify(row)===JSON.stringify(archived)));}
});
test('Resolve closes one material, preserves pending lines and the PO, and closes the case only after the final line',async()=>{
  for(const type of ['transfer','purchase']){
    const r=await request(type,2),[a,b]=r.lines,poBefore=(await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1',[poId])).rows[0];
    const first=await resolve(r,a,{purchaseOrderRef:`  ${poRef.toLowerCase()}  `});assert.equal(first.status,200);const partial=first.body;
    assert.equal(partial.lines[0].status,'closed');assert.equal(partial.lines[0].resolution.purchaseOrderRef,poRef);
    assert.equal(partial.lines[0].resolution.eta,'2026-10-15');assert.deepEqual(partial.lines[1],canonical(b));
    assert.equal(partial.status,'active');assert.equal(partial.bucket,'pending');assert.equal(partial.regular.resolution,undefined);
    const notice=(await http('/api/sales/stock-requests/alerts','sales')).body.requests.find(row=>row.id===r.id);
    assert.equal(notice.lineId,a.id);assert.equal(notice.itemName,a.itemName);assert.equal(notice.purchaseOrderRef,poRef);
    const final=await resolve(partial,b,{eta:'2026-10-16'});assert.equal(final.status,200);assert.equal(final.body.status,'completed');
    assert.equal(final.body.lines[1].resolution.eta,'2026-10-16');assert.equal(final.body.lines[0].resolution.eta,'2026-10-15');
    assert.deepEqual(final.body.lines.map(l=>({q:l.salesQty,u:l.salesUom})),r.lines.map(l=>({q:l.salesQty,u:l.salesUom})));
    assert.deepEqual((await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1',[poId])).rows[0],poBefore);
  }
});
test('mixed proposal, reply, resolve and rejection keep other material state and demand intact',async()=>{
  let r=await request('purchase',4);const [a,b,c,d]=r.lines;
  r=(await send(r,b)).body;r=(await send(r,c)).body;
  r=await addPurchaseStockProposals(r.id,{expectedRevision:r.revision,lines:[{lineId:a.id,reviewedSalesQty:125}]},{operatorId:actors.scm.id},dependencies);
  const proposed=r.lines[0];assert.equal(proposed.purchase.approvedQuantity,200);
  const result=await resolve(r,d);assert.equal(result.status,200);r=result.body;assert.deepEqual(canonical(r.lines[0]),canonical(proposed));
  assert.equal(r.lines[1].replyStatus,'pending_update');assert.equal(r.lines[2].replyStatus,'pending_update');
  const before=await snapshot(r.id);assert.equal((await resolve(r,a)).status,409);assert.deepEqual(await snapshot(r.id),before);
  r=await decideRegularStockRequest(r.id,{expectedRevision:r.revision,lineIds:[b.id],decision:'reject',reason:'Only this material'}, {operatorId:actors.scm.id},dependencies);
  assert.equal(r.lines[1].status,'rejected');assert.equal(r.lines[1].replyStatus,null);assert.equal(r.lines[2].replyStatus,'pending_update');
  r=await addPurchaseStockProposals(r.id,{expectedRevision:r.revision,lines:[{lineId:c.id,reviewedSalesQty:50}]},{operatorId:actors.scm.id},dependencies);
  assert.equal(r.lines[2].replyStatus,null);assert.equal(r.displayStatus,'proposed');
  const repacked=canonical(r.lines[0]);
  assert.deepEqual(repacked.purchase.proposals.map(row=>[row.quantity,row.status]),proposed.purchase.proposals.map(row=>[row.quantity,row.status]));
  repacked.purchase.proposals=canonical(proposed.purchase.proposals);assert.deepEqual(repacked,canonical(proposed));
});
test('invalid, foreign and missing line IDs, stale revisions and unauthorized roles make no writes',async()=>{
  const r=await request(),foreign=await request(),a=r.lines[0],before=await snapshot(r.id);
  for(const lineId of [undefined,null,true,[],{},'1e0',0,-1,1.5,foreign.lines[0].id]){
    assert.ok([400,404,409].includes((await send(r,a,'scm',{lineId})).status));
    assert.ok([400,404,409].includes((await resolve(r,a,{lineId})).status));assert.deepEqual(await snapshot(r.id),before);
  }
  assert.equal((await send(r,a,'scm',{expectedRevision:r.revision+1})).status,409);
  assert.equal((await resolve(r,a,{expectedRevision:r.revision+1})).status,409);
  for(const role of [null,'sales','peer','driver'])assert.ok([401,403].includes((await resolve(r,a,{},role)).status));
  assert.deepEqual(await snapshot(r.id),before);
  const instructions=(await send(r,a)).body,saved=await snapshot(r.id);
  for(const role of ['peer','other'])assert.equal((await send(instructions,a,role)).status,403);
  assert.deepEqual(await snapshot(r.id),saved);
});
test('allocation completion clears a terminal material waiting marker without closing the other proposed material',async()=>{
  let r=await request('purchase',2);const [a,b]=r.lines;
  for(const line of [a,b])r=await addPurchaseStockProposals(r.id,{expectedRevision:r.revision,lines:[{lineId:line.id,reviewedSalesQty:100}]},{operatorId:actors.scm.id},dependencies);
  r=(await send(r,a)).body;r=(await send(r,a,'sales',{message:'A confirmed'})).body;
  assert.equal(r.regular.replyStatus,'pending_scm');assert.ok((await listScmStockRequests({queue:'request'})).some(row=>row.id===r.id));
  const conversation=canonical(r.regular.stockingLines[a.id]);
  await query('UPDATE regular_stock_purchase_demands SET released_quantity=approved_quantity WHERE request_line_id=$1',[a.id]);
  await reconcilePurchaseStockAllocations();r=await getScmStockRequest(r.id);
  assert.equal(r.lines[0].status,'closed');assert.equal(r.lines[0].replyStatus,null);assert.equal(r.lines[1].status,'approved');assert.equal(r.status,'active');
  assert.equal(r.regular.replyStatus,null);assert.deepEqual(r.regular.stockingLines[a.id],conversation);
  assert.equal(r.displayStatus,'proposed');assert.ok(!(await listScmStockRequests({queue:'request'})).some(row=>row.id===r.id));
});
test('Resolve rejects terminal or executing work and a sibling TO does not block the uncommitted material',async()=>{
  let r=await request('transfer');const [a,b,c]=r.lines;
  r=await decideRegularStockRequest(r.id,{expectedRevision:r.revision,lineIds:[a.id],decision:'reject',reason:'Reject A only'},{operatorId:actors.scm.id},dependencies);
  let before=await snapshot(r.id);assert.equal((await resolve(r,a)).status,409);assert.deepEqual(await snapshot(r.id),before);
  const transfer=(await query(`INSERT INTO sales_stock_transfers(request_id,source_location_id,source_name,destination_location_id,destination_name,created_by)
    VALUES($1,1,'Source',28,'Destination',$2) RETURNING id`,[r.id,actors.scm.id])).rows[0];
  await query(`INSERT INTO sales_stock_transfer_lines(transfer_id,request_line_id,item_id,item_name,sales_qty,sales_uom,quantity_mode)
    SELECT $1,id,item_id,item_name,sales_qty,sales_uom,quantity_mode FROM sales_stock_request_lines WHERE id=$2`,[transfer.id,c.id]);
  r=await getScmStockRequest(r.id);before=await snapshot(r.id);
  assert.equal((await resolve(r,c)).status,409);assert.deepEqual(await snapshot(r.id),before);
  const transferBefore=(await query('SELECT to_jsonb(t) AS value FROM sales_stock_transfers t WHERE id=$1',[transfer.id])).rows[0].value;
  const result=await resolve(r,b);assert.equal(result.status,200);assert.equal(result.body.status,'active');assert.equal(result.body.lines[2].status,'submitted');
  assert.deepEqual((await query('SELECT to_jsonb(t) AS value FROM sales_stock_transfers t WHERE id=$1',[transfer.id])).rows[0].value,transferBefore);
  for(const change of [{pickupTransfer:{status:'executing'}},{handoffStatus:'executing'},{deliveryMethod:'pickup'},{legacy:true},{cancelled:true}]){
    let locked=await request();
    await query(`UPDATE sales_stock_requests SET regular_details=regular_details||$2::jsonb,
      workflow_version=CASE WHEN $3 THEN 1 ELSE workflow_version END,status=CASE WHEN $4 THEN 'cancelled' ELSE status END WHERE id=$1`,
      [locked.id,JSON.stringify(change),Boolean(change.legacy),Boolean(change.cancelled)]);
    locked=await getScmStockRequest(locked.id);const saved=await snapshot(locked.id);
    assert.equal((await resolve(locked,locked.lines[0])).status,409);assert.deepEqual(await snapshot(locked.id),saved);
  }
});
test('moving one material to waitlist clears only its waiting status and preserves the other conversation',async()=>{
  const customerId=itemId+1;
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,display_name,legal_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1,'Line customer','Line customer','Line customer','CAD',true,now(),'test',repeat('a',64)) ON CONFLICT DO NOTHING",[customerId]);
  let r=await request('purchase',2);const [a,b]=r.lines;
  r=(await send(r,a)).body;r=(await send(r,b)).body;r=(await send(r,b,'sales',{message:'B is pending SCM review'})).body;
  const other=canonical(r.lines[1]),input={operationKey:randomUUID(),customerId,expectedRevision:r.revision};
  const result=await moveStockingLineToWaitlist(r.id,a.id,input,{operatorId:actors.scm.id});
  assert.equal(result.request.lines[0].status,'cancelled');assert.equal(result.request.lines[0].replyStatus,null);assert.deepEqual(canonical(result.request.lines[1]),other);
  assert.equal(result.request.regular.replyStatus,'pending_scm');assert.equal(result.request.status,'active');
  assert.equal(result.waitlistRequest.lines.length,1);assert.equal(result.waitlistRequest.lines[0].salesQty,a.salesQty);assert.equal(result.waitlistRequest.requestedBy,actors.sales.id);
  const retried=await moveStockingLineToWaitlist(r.id,a.id,input,{operatorId:actors.scm.id});
  assert.equal(retried.waitlistRequest.id,result.waitlistRequest.id);assert.equal(retried.request.revision,result.request.revision);
});
test('concurrent resolution retries are idempotent per material and a different PO/ETA cannot overwrite it',async()=>{
  const r=await request(),[a,b]=r.lines,results=await Promise.all(Array.from({length:6},()=>resolve(r,a)));
  assert.ok(results.every(result=>result.status===200));const updated=results[0].body;assert.equal(updated.revision,r.revision+1);
  assert.equal(updated.lines[1].status,'submitted');assert.equal(updated.events.filter(e=>e.details.decision==='resolve'&&e.requestLineId===a.id).length,1);
  const before=await snapshot(r.id);assert.equal((await resolve(r,a,{eta:'2026-10-17'})).status,409);assert.deepEqual(await snapshot(r.id),before);
  const concurrent=await Promise.all([resolve(updated,b),send(updated,updated.lines[2])]);
  assert.equal(concurrent.filter(result=>result.status===200).length,1);assert.equal(concurrent.filter(result=>result.status===409).length,1);
});
test('a closed material cannot be replied to or proposed, and single-line legacy callers remain supported',async()=>{
  const r=await request(),a=r.lines[0],closed=(await resolve(r,a)).body,before=await snapshot(r.id);
  assert.equal((await send(closed,a)).status,409);
  await assert.rejects(()=>addPurchaseStockProposals(r.id,{expectedRevision:closed.revision,lines:[{lineId:a.id}]},{operatorId:actors.scm.id},dependencies));
  assert.deepEqual(await snapshot(r.id),before);
  const one=await request('purchase',1),reply=(await send(one,one.lines[0],'scm',{lineId:undefined})).body;
  assert.equal(reply.lines[0].replyStatus,'pending_update');const final=await resolve(reply,reply.lines[0],{lineId:undefined});
  assert.equal(final.status,200);assert.equal(final.body.regular.resolution.purchaseOrderRef,poRef);assert.equal(outbound,0);
});

test('legacy request-wide resolution can be corrected to one material with an audit entry and three pending lines',async()=>{
  const r=await request('purchase',4),a=r.lines[0],resolution={purchaseOrderId:poId,purchaseOrderRef:poRef,eta:'2026-10-08',resolvedBy:actors.scm.id,resolvedAt:new Date().toISOString()};
  await query("UPDATE sales_stock_request_lines SET item_name=item_name||'-'||id WHERE request_id=$1",[r.id]);
  const itemName='Line material-'+a.id;
  await query("UPDATE sales_stock_request_lines SET status='closed',regular_decision='po',decision_reason=$2,decided_by=$3,decided_at=now() WHERE request_id=$1",[r.id,`Resolved with ${poRef}; ETA 2026-10-08.`,actors.scm.id]);
  const event=(await query("INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details) VALUES($1,'regular_manual_decision',$2,$3::jsonb) RETURNING id",[r.id,actors.scm.id,JSON.stringify({decision:'resolve',...resolution})])).rows[0];
  await query("UPDATE sales_stock_requests SET status='completed',revision=2,manual_decision_event_id=$2,regular_details=regular_details||jsonb_build_object('resolution',$3::jsonb) WHERE id=$1",[r.id,event.id,JSON.stringify(resolution)]);
  const input={requestId:r.id,requestRef:r.requestRef,lineName:itemName,expectedRevision:2,purchaseOrderRef:poRef,eta:'2026-10-08'},before=await snapshot(r.id);
  const dry=await repairStockingResolutionScope(input,{rollback:true});assert.equal(dry.changed,true);assert.deepEqual(await snapshot(r.id),before);
  const result=await repairStockingResolutionScope(input);assert.equal(result.changed,true);
  const repaired=await getScmStockRequest(r.id);assert.equal(repaired.revision,3);assert.equal(repaired.status,'active');assert.equal(repaired.bucket,'pending');
  assert.deepEqual(repaired.lines[0].resolution,resolution);assert.equal(repaired.regular.resolution,undefined);
  for(const line of repaired.lines.slice(1)){assert.equal(line.status,'submitted');assert.equal(line.decision,null);assert.equal(line.decisionReason,'');assert.equal(line.resolution,null);}
  assert.equal(repaired.events[0].requestLineId,a.id);assert.equal(repaired.events[0].details.correctionOfEventId,Number(event.id));
  assert.deepEqual((await snapshot(r.id)).lines.map(l=>[l.sales_qty,l.sales_uom,l.approval_evidence]),before.lines.map(l=>[l.sales_qty,l.sales_uom,l.approval_evidence]));
  assert.equal((await repairStockingResolutionScope(input)).changed,false);
});
