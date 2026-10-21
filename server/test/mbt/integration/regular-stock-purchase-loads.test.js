import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {submitRegularStockRequest,regularStockAlerts} from '../../../src/regular-stock-request-service.js';
import {addPurchaseStockProposals,releasePurchaseStockDemand,syncPurchaseStockDemand} from '../../../src/regular-stock-purchase-service.js';
import {reconcilePurchaseStockAllocations} from '../../../src/regular-stock-purchase-repository.js';
import {getScmStockRequest,listScmStockRequests} from '../../../src/stock-request-repository.js';
import {groupSmartScmProposals,recalculateSmartScmPoProposal,splitSmartScmProposalLine,removeSmartScmProposalLine,updateSmartScmProposalLine} from '../../../src/smart-scm-proposal-editor.js';
import {completeSmartScmPurchaseExecution,stageSmartScmVendorReplyLoad,removeSmartScmNetSuitePoReviewLoad,markSmartScmPurchaseAttention,failSmartScmPurchaseExecution} from '../../../src/smart-scm-vendor-repository.js';
import {upsertPurchaseOrderLines,markMissingInboundOrderLines,updatePurchaseOrderNetSuiteStatus,upsertPurchaseOrders} from '../../../src/order-sync-repository.js';
import {persistPurchaseStockDrafts,getSmartScmPlanningRun,updateSmartScmProposal} from '../../../src/smart-scm-planning-repository.js';
const fixtureId=Date.now()%1000000000;
const actor=`purchase-loads-${Date.now()}`,baseItem=9800000000000+fixtureId,source=910002;
const context={operatorId:actor,authorizedDestinationLocationIds:[1,28,26],allowOverAvailability:false};
const policy=id=>({item_id:id,item_name:`Purchase loads ${id}`,stock_unit:'EA',to_plt:100,pallet_weight_lbs:1000,vendor_id:source,vendor:'Purchase loads vendor',vendor_yard_id:source,vendor_yard:'Purchase loads source',plant:'Purchase loads source'});
const deps={loadPurchaseStock:async()=>({onHand:0,available:0,preferredStock:1000}),loadPurchasePolicy:async id=>policy(id)};
let runId,sequence=0;
before(async()=>{
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','scm',ARRAY['scm'],true)",[actor]);
  await query("INSERT INTO dispatch_vendor_yards(id,vendor,yard) VALUES($1,'Purchase loads vendor','Purchase loads source') ON CONFLICT(id) DO NOTHING",[source]);
  runId=Number((await query("INSERT INTO scm_smart_planning_runs(trigger_source,status,plan_kind,settings_snapshot) VALUES('purchase-tests','ready','inventory','{\"truck_capacity_lbs\":78000}') RETURNING id")).rows[0].id);
});
after(closeDb);
async function accepted(qty=150,yard=28,itemId=baseItem+sequence++,acceptDependencies=deps){
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight,vendor_id,vendor,purchase_unit,last_purchase_price) VALUES($1,$2,'EA',1,100,10,$3,'Purchase loads vendor','EA',1) ON CONFLICT(item_id) DO UPDATE SET to_plt=100",[itemId,`Purchase loads ${itemId}`,source]);
  const request=await submitRegularStockRequest({deliveryMethod:'stocking',stockingType:'purchase',destinationLocationId:yard,lines:[{itemId,pieces:qty}]},context,deps);
  return addPurchaseStockProposals(request.id,{expectedRevision:request.revision,lines:[{lineId:request.lines[0].id}]},context,acceptDependencies);
}
async function order(proposalId,itemId,quantity,received=0){
  const id=9900000000000+fixtureId+sequence++;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,vendor,status_text,netsuite_active,destination_location_id,vendor_reference) VALUES($1,$2,$3,'Purchase loads vendor','Pending Receipt',true,28,'VENDOR-REF')",[id,`PO-PURCHASE-${id}`,source]);
  await upsertPurchaseOrderLines(id,[{line_id:1,item_id:itemId,item_name:'Purchase load material',quantity,netsuite_received_qty:received,unit:'EA',to_plt:100,pallet_qty:quantity/100,location_id:28,netsuite_active:true,item_weight:10}]);
  await completeSmartScmPurchaseExecution(proposalId,{purchaseOrderId:id,purchaseOrderRef:`PO-PURCHASE-${id}`},actor);
  return id;
}
test('vendor-yard grouping combines requests and destinations without losing item ownership',async()=>{
  const a=await accepted(150,28),b=await accepted(50,1);
  const currentA=await getScmStockRequest(a.id),currentB=await getScmStockRequest(b.id);
  assert.equal(currentA.lines[0].purchase.proposals[0].proposalId,currentB.lines[0].purchase.proposals[0].proposalId);
  assert.equal(currentA.lines[0].purchase.approvedQuantity,200);assert.equal(currentB.lines[0].purchase.approvedQuantity,100);
  assert(!(await listScmStockRequests({queue:'request'})).some(row=>row.id===a.id));
  assert((await listScmStockRequests({queue:'approved'})).some(row=>row.id===a.id));
  assert((await regularStockAlerts({operatorId:actor,authorizedDestinationLocationIds:[1,28]})).requests.some(row=>row.id===a.id));
});
test('merging ordinary demand with matching request items preserves separate request allocations and FIFO receipts',async()=>{
  const a=await accepted(150),itemId=a.lines[0].itemId,b=await accepted(50,28,itemId);
  const current=await getScmStockRequest(a.id),purchaseId=current.lines[0].purchase.proposals[0].proposalId;
  const purchase=(await query('SELECT * FROM scm_smart_proposals WHERE id=$1',[purchaseId])).rows[0];
  const line={itemId,itemName:'Ordinary matching item',itemDescription:'',unit:'EA',requiredPallets:3,proposedPallets:3,confirmedPallets:0,residualPallets:3,salesQuantity:300,palletWeight:1000,lineWeight:3000,toPlt:100,toLyr:0,toSec:0,toPcs:1,manualPlanningRequired:false,destinationLocationId:28,destinationName:'2967',reason:{}};
  await persistPurchaseStockDrafts(purchase.run_id,[{proposalKey:`ordinary-${a.id}`,proposalType:'PO',phase:'direct_vendor',sourceKind:'vendor',sourceVendorYardId:source,sourceName:purchase.source_name,plant:purchase.plant,vendor:purchase.vendor,destinationLocationId:28,destinationName:'2967',status:'held',urgent:false,provisional:false,totalPallets:3,totalWeight:3000,utilization:3000/78000,memo:'Ordinary demand',lines:[line]}]);
  const ordinaryId=Number((await query('SELECT id FROM scm_smart_proposals WHERE proposal_key=$1',[`ordinary-${a.id}`])).rows[0].id);
  const merged=await groupSmartScmProposals([ordinaryId,purchaseId],actor);
  const mergedLine=merged.proposals.flatMap(proposal=>proposal.lines.map(l=>({...l,proposalId:proposal.id}))).find(l=>l.itemId===itemId&&l.reason?.purchaseDemandIds?.includes(a.lines[0].purchase.demandId));
  assert(mergedLine);assert.equal(mergedLine.salesQuantity,600);
  const movedA=await getScmStockRequest(a.id);assert.equal(movedA.lines[0].purchase.proposals[0].proposalId,mergedLine.proposalId);
  const poId=await order(mergedLine.proposalId,itemId,600,150);
  const partialA=await getScmStockRequest(a.id),partialB=await getScmStockRequest(b.id);
  assert.equal(partialA.bucket,'accepted');assert.equal(partialA.lines[0].purchase.receivedQuantity,150);
  assert.equal(partialB.lines[0].purchase.receivedQuantity,0);assert.equal(partialA.lines[0].purchase.orderedQuantity,200);assert.equal(partialB.lines[0].purchase.orderedQuantity,100);
  assert.equal(partialA.lines[0].purchase.orders[0].purchaseOrderRef,'VENDOR-REF');
  await upsertPurchaseOrderLines(poId,[{line_id:1,item_id:itemId,item_name:'Received material',quantity:600,netsuite_received_qty:300,unit:'EA',to_plt:100,pallet_qty:6,location_id:28,netsuite_active:true,item_weight:10}]);
  assert.equal((await getScmStockRequest(a.id)).bucket,'completed');assert.equal((await getScmStockRequest(b.id)).bucket,'completed');
});
test('split and recalculation retain request links; deletion requeues and repeated builds do not duplicate them',async()=>{
  const request=await accepted(150),item=request.lines[0];
  const proposalId=item.purchase.proposals[0].proposalId;
  const plan=await splitSmartScmProposalLine(proposalId,item.purchase.proposals[0].lineId,{},actor);
  let current=await getScmStockRequest(request.id);
  assert.notEqual(current.lines[0].purchase.proposals[0].proposalId,proposalId);
  const splitId=current.lines[0].purchase.proposals[0].proposalId;
  await recalculateSmartScmPoProposal(splitId,actor);
  current=await getScmStockRequest(request.id);
  assert.notEqual(current.lines[0].purchase.proposals[0].proposalId,splitId);
  const toDelete=current.lines[0].purchase.proposals[0];
  await removeSmartScmProposalLine(toDelete.proposalId,toDelete.lineId,actor);
  assert.equal((await getScmStockRequest(request.id)).lines[0].purchase.unorderedQuantity,200);
  await syncPurchaseStockDemand({runId});await syncPurchaseStockDemand({runId});
  current=await getScmStockRequest(request.id);
  assert.equal(current.lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),200);
  const nextRun=Number((await query("INSERT INTO scm_smart_planning_runs(trigger_source,status,plan_kind,settings_snapshot) VALUES('purchase-next','ready','inventory','{\"truck_capacity_lbs\":78000}') RETURNING id")).rows[0].id);
  await syncPurchaseStockDemand({runId:nextRun});
  assert((await getSmartScmPlanningRun(nextRun)).proposals.some(p=>p.purchaseRequests.some(link=>Number(link.requestId)===request.id)));
  assert(plan.proposals.length>0);
});
test('other incoming orders are informational; reduced/cancelled linked POs leave demand active',async()=>{
  const request=await accepted(150),item=request.lines[0];
  const other=9901000000000+fixtureId+sequence++;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active,destination_location_id) VALUES($1,'PO-OTHER','Pending Receipt',true,28)",[other]);
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,quantity,netsuite_received_qty,unit,to_plt,location_id,netsuite_active) VALUES($1,1,$2,900,0,'EA',100,28,true)",[other,item.itemId]);
  const withOther=await getScmStockRequest(request.id);
  assert(withOther.lines[0].purchase.orders.some(row=>row.direct===false&&row.purchaseOrderNumber==='PO-OTHER'));
  assert.equal(withOther.lines[0].purchase.orderedQuantity,0);
  const poId=await order(item.purchase.proposals[0].proposalId,item.itemId,100);
  assert.equal((await getScmStockRequest(request.id)).lines[0].purchase.unorderedQuantity,100);
  await query("UPDATE purchase_orders SET status_text='Cancelled' WHERE netsuite_id=$1",[poId]);
  await reconcilePurchaseStockAllocations();await syncPurchaseStockDemand({runId});
  const cancelled=await getScmStockRequest(request.id);
  assert.equal(cancelled.lines[0].purchase.unorderedQuantity,200);
  assert(cancelled.lines[0].purchase.orders.some(row=>row.direct&&row.status==='Cancelled'));
  const released=await releasePurchaseStockDemand(request.id,{expectedRevision:cancelled.revision,lineIds:[item.id],reason:'Cancelled requirement'},context);
  assert.equal(released.bucket,'completed');assert.equal(released.lines[0].purchase.receivedQuantity,0);
});
test('truck capacity creates multiple complete loads and grouping never defers accepted Purchase quantity',async()=>{
  const request=await accepted(20000),item=request.lines[0];
  const links=item.purchase.proposals;
  assert(links.length>=3);assert.equal(links.reduce((sum,row)=>sum+row.quantity,0),20000);
  await groupSmartScmProposals(links.map(row=>row.proposalId),actor);
  const current=await getScmStockRequest(request.id);
  assert.equal(current.lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),20000);
  const loads=(await query('SELECT p.total_weight_lbs,p.route_stops FROM scm_smart_proposals p WHERE id=ANY($1::bigint[])',[current.lines[0].purchase.proposals.map(row=>row.proposalId)])).rows;
  const capacity=Number((await query('SELECT truck_capacity_lbs FROM scm_smart_settings WHERE id=1')).rows[0].truck_capacity_lbs);
  for(const load of loads){assert(Number(load.total_weight_lbs)<=capacity);assert(load.route_stops.length<=2);}
});
test('partial vendor confirmation retains both requests, requeues the remainder and permits removal before a PO exists',async()=>{
  const a=await accepted(150),b=await accepted(50,28,a.lines[0].itemId);
  let current=await getScmStockRequest(a.id),link=current.lines[0].purchase.proposals[0];
  await splitSmartScmProposalLine(link.proposalId,link.lineId,{},actor);
  current=await getScmStockRequest(a.id);link=current.lines[0].purchase.proposals[0];
  await query("UPDATE scm_smart_proposals SET status='order_requested',order_requested_at=now() WHERE id=$1",[link.proposalId]);
  await assert.rejects(()=>releasePurchaseStockDemand(a.id,{expectedRevision:current.revision,lineIds:[current.lines[0].id],reason:'Too late'},context),e=>e.status===409);
  const staged=await stageSmartScmVendorReplyLoad(link.proposalId,{lines:[{proposalLineId:link.lineId,decision:'confirm',decisionPallets:1}]},actor);
  assert(staged.reviewProposalId);
  await syncPurchaseStockDemand({runId});
  const pendingA=await getScmStockRequest(a.id),pendingB=await getScmStockRequest(b.id);
  assert.equal(pendingA.lines[0].purchase.orderedQuantity,0);assert.equal(pendingB.lines[0].purchase.orderedQuantity,0);
  assert.equal(pendingA.lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),200);
  assert.equal(pendingB.lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),100);
  await removeSmartScmNetSuitePoReviewLoad(staged.reviewProposalId,actor);
  await syncPurchaseStockDemand({runId});
  assert.equal((await getScmStockRequest(a.id)).lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),200);
});
test('an external PO awaiting item sync reserves demand without inventing an order quantity or receipt',async()=>{
  const request=await accepted(150),item=request.lines[0],poId=9902000000000+fixtureId+sequence++;
  await completeSmartScmPurchaseExecution(item.purchase.proposals[0].proposalId,{purchaseOrderId:poId,purchaseOrderRef:'PO-DELAYED'},actor);
  await syncPurchaseStockDemand({runId});await syncPurchaseStockDemand({runId});
  let current=await getScmStockRequest(request.id);
  assert.equal(current.bucket,'accepted');assert.equal(current.lines[0].purchase.orderedQuantity,0);
  assert.equal(current.lines[0].purchase.pendingVerificationQuantity,200);
  assert.equal(current.lines[0].purchase.proposals.length,0);
  assert(current.lines[0].purchase.orders.some(row=>row.purchaseOrderNumber==='PO-DELAYED'&&row.pendingVerification));
  await assert.rejects(()=>releasePurchaseStockDemand(request.id,{expectedRevision:current.revision,lineIds:[item.id],reason:'Do not release an unknown PO'},context),e=>e.status===409);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active,destination_location_id) VALUES($1,'PO-DELAYED','Pending Receipt',true,28)",[poId]);
  await upsertPurchaseOrderLines(poId,[{line_id:1,item_id:item.itemId,quantity:200,netsuite_received_qty:50,unit:'EA',to_plt:100,pallet_qty:2,location_id:28,netsuite_active:true}]);
  current=await getScmStockRequest(request.id);
  assert.equal(current.lines[0].purchase.pendingVerificationQuantity,0);assert.equal(current.lines[0].purchase.orderedQuantity,200);assert.equal(current.lines[0].purchase.receivedQuantity,50);
  await markMissingInboundOrderLines(poId,[]);
  current=await getScmStockRequest(request.id);
  assert.equal(current.lines[0].purchase.unorderedQuantity,150);assert.equal(current.lines[0].purchase.receivedQuantity,50);
});
test('native purchase UOM receipts and changed pallet conversions preserve actual sales-unit receipt quantities',async()=>{
  const request=await accepted(150),item=request.lines[0],link=item.purchase.proposals[0];
  const poId=await order(link.proposalId,item.itemId,200);
  await upsertPurchaseOrderLines(poId,[{line_id:1,item_id:item.itemId,quantity:2,netsuite_received_qty:1,unit:'PALLET',to_plt:100,pallet_qty:2,location_id:28,netsuite_active:true}]);
  let current=await getScmStockRequest(request.id);
  assert.equal(current.bucket,'accepted');assert.equal(current.lines[0].purchase.receivedQuantity,100);
  await upsertPurchaseOrderLines(poId,[{line_id:1,item_id:item.itemId,quantity:200,netsuite_received_qty:100,unit:'EA',to_plt:50,pallet_qty:4,location_id:28,netsuite_active:true}]);
  current=await getScmStockRequest(request.id);
  assert.equal(current.bucket,'accepted');assert.equal(current.lines[0].purchase.receivedQuantity,100);
  assert.equal(current.lines[0].purchase.orderedQuantity,200);
});
test('a non-pallet PO reduction carries exactly the accepted remainder without adding a second rounding surplus',async()=>{
  const request=await accepted(150),item=request.lines[0];
  await order(item.purchase.proposals[0].proposalId,item.itemId,75);
  await syncPurchaseStockDemand({runId});
  const current=await getScmStockRequest(request.id);
  assert.equal(current.lines[0].purchase.unorderedQuantity,125);
  const pending=(await query(`SELECT SUM(l.sales_quantity) AS quantity FROM scm_smart_proposal_lines l
    JOIN scm_smart_proposals p ON p.id=l.proposal_id WHERE l.item_id=$1 AND p.status='held' AND p.netsuite_purchase_order_id IS NULL`,[item.itemId])).rows[0];
  assert.equal(Number(pending.quantity),125);
  const link=current.lines[0].purchase.proposals[0];
  await recalculateSmartScmPoProposal(link.proposalId,actor);
  const recalculated=await getScmStockRequest(request.id);
  assert.equal(recalculated.lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),125);
});
test('incomplete hydration of an existing multi-item PO cannot duplicate an unverified item',async()=>{
  const request=await accepted(150),item=request.lines[0],poId=9904000000000+fixtureId+sequence++;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active,destination_location_id) VALUES($1,'PO-PARTIAL-SYNC','Pending Receipt',true,28)",[poId]);
  await upsertPurchaseOrderLines(poId,[{line_id:1,item_id:item.itemId+10000,quantity:100,unit:'EA',to_plt:100,pallet_qty:1,location_id:28,netsuite_active:true}]);
  await markSmartScmPurchaseAttention(item.purchase.proposals[0].proposalId,{purchaseOrderId:poId,purchaseOrderRef:'PO-PARTIAL-SYNC',error:'Incomplete item hydration'},actor);
  await syncPurchaseStockDemand({runId});
  const current=await getScmStockRequest(request.id);
  assert.equal(current.lines[0].purchase.pendingVerificationQuantity,200);assert.equal(current.lines[0].purchase.proposals.length,0);
});
test('transactional PO receipts and header cancellation/reopening reconcile request quantities',async()=>{
  const request=await accepted(150),item=request.lines[0],poId=await order(item.purchase.proposals[0].proposalId,item.itemId,200);
  await withTransaction(()=>upsertPurchaseOrderLines(poId,[{line_id:1,item_id:item.itemId,quantity:200,netsuite_received_qty:50,unit:'EA',to_plt:100,pallet_qty:2,location_id:28,netsuite_active:true}]));
  assert.equal((await getScmStockRequest(request.id)).lines[0].purchase.receivedQuantity,50);
  await updatePurchaseOrderNetSuiteStatus(poId,{statusText:'Cancelled'});
  assert.equal((await getScmStockRequest(request.id)).lines[0].purchase.unorderedQuantity,150);
  await upsertPurchaseOrders([{id:poId,tranid:`PO-PURCHASE-${poId}`,vendor_id:source,vendor:'Purchase loads vendor',destination_location_id:28,status_text:'Pending Receipt'}]);
  assert.equal((await getScmStockRequest(request.id)).lines[0].purchase.orderedQuantity,200);
});
test('SCM load quantity edits remain independent, and cancellation or definite execution failure requeues only the missing quantity',async()=>{
  const request=await accepted(150),item=request.lines[0],link=item.purchase.proposals[0];
  await query(`INSERT INTO scm_smart_item_policies(item_id,item_name,to_plt,planning_enabled,pallet_weight_lbs,vendor_yard_id,vendor_yard,vendor)
    VALUES($1,$2,100,false,1000,$3,'Purchase loads source','Purchase loads vendor')`,[item.itemId,item.itemName,source]);
  await query("INSERT INTO scm_smart_item_yard_policies(item_id,location_id,yard_code,eligible,capacity_pallets) VALUES($1,28,'2967',true,50)",[item.itemId]);
  await assert.rejects(()=>updateSmartScmProposalLine(link.proposalId,link.lineId,{proposedPallets:1,destinationLocationId:1},actor),e=>e.status===409);
  await updateSmartScmProposalLine(link.proposalId,link.lineId,{proposedPallets:1},actor);
  await syncPurchaseStockDemand({runId});
  let current=await getScmStockRequest(request.id);
  assert.equal(current.lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),200);
  assert(current.lines[0].purchase.proposals.some(row=>row.proposalId===link.proposalId&&row.quantity===100));
  await updateSmartScmProposal(link.proposalId,{status:'cancelled'},actor);
  await syncPurchaseStockDemand({runId});
  current=await getScmStockRequest(request.id);
  const pending=current.lines[0].purchase.proposals[0];
  await failSmartScmPurchaseExecution(pending.proposalId,new Error('Definite execution failure with no external PO'),actor);
  await syncPurchaseStockDemand({runId});
  assert.equal((await getScmStockRequest(request.id)).lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),200);
});
test('releasing a request from a merged load preserves the ordinary quantity and derived weight',async()=>{
  const request=await accepted(150),item=request.lines[0],link=item.purchase.proposals[0];
  const purchase=(await query('SELECT * FROM scm_smart_proposals WHERE id=$1',[link.proposalId])).rows[0];
  const key=`release-ordinary-${request.id}`;
  const line={itemId:item.itemId,itemName:item.itemName,itemDescription:'',unit:'EA',requiredPallets:1,proposedPallets:1,confirmedPallets:0,residualPallets:1,salesQuantity:100,palletWeight:1000,lineWeight:1000,toPlt:100,toLyr:0,toSec:0,toPcs:1,manualPlanningRequired:false,destinationLocationId:28,destinationName:'2967',reason:{}};
  await persistPurchaseStockDrafts(purchase.run_id,[{proposalKey:key,proposalType:'PO',phase:'direct_vendor',sourceKind:'vendor',sourceVendorYardId:source,sourceName:purchase.source_name,plant:purchase.plant,vendor:purchase.vendor,destinationLocationId:28,destinationName:'2967',status:'held',urgent:false,provisional:false,totalPallets:1,totalWeight:1000,utilization:1000/78000,memo:'Ordinary release fixture',lines:[line]}]);
  const ordinaryId=Number((await query('SELECT id FROM scm_smart_proposals WHERE proposal_key=$1',[key])).rows[0].id);
  await groupSmartScmProposals([ordinaryId,link.proposalId],actor);
  const current=await getScmStockRequest(request.id),merged=current.lines[0].purchase.proposals[0];
  const beforeRows=(await query('SELECT * FROM scm_smart_proposal_lines WHERE proposal_id=$1',[merged.proposalId])).rows;
  const beforeHeader=(await query('SELECT total_pallets,total_weight_lbs FROM scm_smart_proposals WHERE id=$1',[merged.proposalId])).rows[0];
  const released=await releasePurchaseStockDemand(request.id,{expectedRevision:current.revision,lineIds:[item.id],reason:'No longer required'},context);
  assert.equal(released.bucket,'completed');assert.equal(released.lines[0].purchase.receivedQuantity,0);assert.equal(released.lines[0].purchase.proposals.length,0);
  const remaining=(await query('SELECT * FROM scm_smart_proposal_lines WHERE proposal_id=$1',[merged.proposalId])).rows;
  const ordinary=remaining.find(row=>Number(row.item_id)===item.itemId);
  assert.equal(Number(ordinary.sales_quantity),100);assert.equal(Number(ordinary.proposed_pallets),1);
  for(const other of beforeRows.filter(row=>Number(row.item_id)!==item.itemId))assert.equal(Number(remaining.find(row=>Number(row.item_id)===Number(other.item_id)).sales_quantity),Number(other.sales_quantity));
  const header=(await query('SELECT total_pallets,total_weight_lbs,status FROM scm_smart_proposals WHERE id=$1',[merged.proposalId])).rows[0];
  assert.equal(Number(header.total_pallets),Number(beforeHeader.total_pallets)-2);assert.equal(header.status,'held');
  const physical=Number((await query("SELECT item_weight FROM inventory_items WHERE UPPER(BTRIM(item_name))='PALLET' ORDER BY item_id LIMIT 1")).rows[0]?.item_weight)||0;
  assert.equal(Number(header.total_weight_lbs),Number(beforeHeader.total_weight_lbs)-2*(1000+physical));
});
test('an unknown PO UOM reserves the item until verified, but a cancelled PO cannot keep it reserved',async()=>{
  const request=await accepted(150),item=request.lines[0],poId=await order(item.purchase.proposals[0].proposalId,item.itemId,200);
  await query("UPDATE purchase_order_lines SET unit='UNKNOWN-UOM',to_plt=0,pallet_qty=NULL WHERE purchase_order_id=$1",[poId]);
  await reconcilePurchaseStockAllocations();await syncPurchaseStockDemand({runId});
  let current=await getScmStockRequest(request.id);
  assert.equal(current.lines[0].purchase.pendingVerificationQuantity,200);assert.equal(current.lines[0].purchase.proposals.length,0);assert.equal(current.lines[0].purchase.receivedQuantity,0);
  await updatePurchaseOrderNetSuiteStatus(poId,{statusText:'Cancelled'});
  await syncPurchaseStockDemand({runId});current=await getScmStockRequest(request.id);
  assert.equal(current.lines[0].purchase.pendingVerificationQuantity,0);assert.equal(current.lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),200);
});
test('different frozen pallet conversions cannot merge or be accepted over an existing item demand',async()=>{
  const request=await accepted(150),item=request.lines[0],link=item.purchase.proposals[0];
  const purchase=(await query('SELECT * FROM scm_smart_proposals WHERE id=$1',[link.proposalId])).rows[0];
  const key=`conversion-conflict-${request.id}`;
  const line={itemId:item.itemId,itemName:item.itemName,itemDescription:'',unit:'EA',requiredPallets:1,proposedPallets:1,confirmedPallets:0,residualPallets:1,salesQuantity:50,palletWeight:500,lineWeight:500,toPlt:50,toLyr:0,toSec:0,toPcs:1,manualPlanningRequired:false,destinationLocationId:28,destinationName:'2967',reason:{}};
  await persistPurchaseStockDrafts(purchase.run_id,[{proposalKey:key,proposalType:'PO',phase:'direct_vendor',sourceKind:'vendor',sourceVendorYardId:source,sourceName:purchase.source_name,plant:purchase.plant,vendor:purchase.vendor,destinationLocationId:28,destinationName:'2967',status:'held',urgent:false,provisional:false,totalPallets:1,totalWeight:500,utilization:500/78000,memo:'Different conversion fixture',lines:[line]}]);
  const ordinaryId=Number((await query('SELECT id FROM scm_smart_proposals WHERE proposal_key=$1',[key])).rows[0].id);
  await assert.rejects(()=>groupSmartScmProposals([ordinaryId,link.proposalId],actor),e=>e.status===409&&/conversion/.test(e.message));
  const second=await submitRegularStockRequest({deliveryMethod:'stocking',stockingType:'purchase',destinationLocationId:28,lines:[{itemId:item.itemId,pieces:50}]},context,deps);
  await assert.rejects(()=>addPurchaseStockProposals(second.id,{expectedRevision:second.revision,lines:[{lineId:second.lines[0].id}]},context,{...deps,loadPurchasePolicy:async id=>({...policy(id),to_plt:50})}),e=>e.status===409&&/conversion/.test(e.message));
  assert.equal((await getScmStockRequest(second.id)).bucket,'pending');assert.equal((await getScmStockRequest(request.id)).lines[0].purchase.approvedQuantity,200);
});
test('Gormley Purchase destinations stay at the requesting shop instead of the automatic partial-load hub',async()=>{
  const vendorYard=910004;
  await query("INSERT INTO dispatch_vendor_yards(id,vendor,yard) VALUES($1,'Gormley Purchase vendor','Gormley') ON CONFLICT(id) DO NOTHING",[vendorYard]);
  const gormley={...deps,loadPurchasePolicy:async id=>({...policy(id),vendor_yard_id:vendorYard,vendor_yard:'Gormley',plant:'Gormley'})};
  const a=await accepted(50,28,baseItem+sequence++,gormley),b=await accepted(50,26,baseItem+sequence++,gormley);
  for(const request of [a,b]){
    const current=await getScmStockRequest(request.id);
    assert.equal(current.lines[0].purchase.proposals.reduce((sum,row)=>sum+row.quantity,0),100);
    const rows=(await query('SELECT destination_location_id FROM scm_smart_proposal_lines WHERE id=ANY($1::bigint[])',[current.lines[0].purchase.proposals.map(row=>row.lineId)])).rows;
    assert(rows.every(row=>Number(row.destination_location_id)===request.destinationLocationId));
  }
});
test('acceptance creates an independent planning run when none is ready and rolls back overweight demand',async()=>{
  await withTransaction(async()=>{
    await query("UPDATE scm_smart_planning_runs SET status='failed' WHERE status='ready' AND plan_kind='inventory'");
    const request=await accepted(50);
    const created=(await query('SELECT r.trigger_source,r.status FROM scm_smart_planning_runs r JOIN scm_smart_proposals p ON p.run_id=r.id WHERE p.id=$1',[request.lines[0].purchase.proposals[0].proposalId])).rows[0];
    assert.deepEqual(created,{trigger_source:'stocking-purchase',status:'ready'});
  },{rollback:true});
  await withTransaction(async()=>{
    const itemId=baseItem+sequence++;
    await query("UPDATE scm_smart_settings SET truck_capacity_lbs=100 WHERE id=1");
    await assert.rejects(()=>accepted(50,28,itemId),e=>e.status===409&&/truck capacity/.test(e.message));
    assert.equal(Number((await query('SELECT count(*) AS n FROM regular_stock_purchase_demands d JOIN sales_stock_request_lines l ON l.id=d.request_line_id WHERE l.item_id=$1',[itemId])).rows[0].n),0);
  },{rollback:true});
});
