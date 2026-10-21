import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {submitRegularStockRequest,decideRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import {enqueueRegularReplenishments,syncRegularReplenishments,releaseRegularReplenishment,listRegularReplenishments} from '../../../src/regular-stock-replenishment.js';
import {runSmartScmPlan,getSmartScmPlanningRun,approveSmartScmPoPhase,updateSmartScmProposal} from '../../../src/smart-scm-planning-repository.js';
import {addSmartScmProposalLine} from '../../../src/smart-scm-proposal-editor.js';
import {addSmartScmVendorAlternativeLine} from '../../../src/smart-scm-vendor-repository.js';
import {convertSalesStockRequestLines,getScmStockRequest} from '../../../src/stock-request-repository.js';
const actor=`regular-po-${Date.now()}`,itemId=9800000000020;
const context={operatorId:actor,authorizedDestinationLocationIds:[28],allowOverAvailability:true};
let runId;
const state=(position=899)=>({key:`${itemId}:1`,policy:{item_id:itemId,location_id:1,yard_code:'3445',item_name:'Regular PO fixture',stock_unit:'EA',vendor:'Fixture vendor',plant:'Fixture source',to_plt:1,pallet_weight_lbs:20},toPlt:1,preferred:1200,positionPallets:position,safety:800,availableSales:799,inventorySyncedAt:new Date(),requiredPallets:301,manualPlanningRequired:false});
const planning=(position)=>({states:[state(position)],settings:{truck_capacity_lbs:78000},forecastRunId:null});
before(async()=>{
 await query("UPDATE regular_stock_replenishments SET released_at=now() WHERE item_id=$1 AND released_at IS NULL",[itemId]);
 await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)`,[actor]);
 await query(`INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight) VALUES($1,$2,'EA',1,1,20) ON CONFLICT(item_id) DO NOTHING`,[itemId,actor]);
 await query(`INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT(item_id,location_id) DO NOTHING`,[itemId]);
 runId=Number((await query(`INSERT INTO scm_smart_planning_runs(trigger_source,status,settings_snapshot,plan_kind) VALUES('regular-test','ready','{}','inventory') RETURNING id`)).rows[0].id);
});
after(closeDb);
async function approved(){
 const deps={now:()=>new Date('2026-09-29T14:00:00Z'),refreshAvailability:async()=>{},loadPolicies:async()=>[]};
 const r=await submitRegularStockRequest({destinationLocationId:28,deliveryMethod:'delivery',arrivalDate:'2026-09-29',arrivalTime:'15:00',lines:[{itemId,sourceLocationId:1,pieces:201}]},context,deps);
 const a=await decideRegularStockRequest(r.id,{expectedRevision:r.revision,lineIds:[r.lines[0].id],decision:'po'},context,deps);
 // Replenishment is called only after a persisted external SO/TO commitment.
 await query(`INSERT INTO regular_stock_handoffs(request_id,sales_order_id,sales_order_ref,plan,location_applied) VALUES($1,$2,$3,'{"mode":"location"}',true)`,[a.id,a.id+900000,`SO-${a.id}`]);
 return a;
}
test('same item/source shares one priority group and repeated sync does not duplicate load',async()=>{
 const a=await approved(),b=await approved();
 await enqueueRegularReplenishments(a);await enqueueRegularReplenishments(b);
 await syncRegularReplenishments({runId,planning:planning()});
 const first=(await listRegularReplenishments()).find(g=>g.itemId===itemId);
 assert.equal(first.quantity,301);assert.equal(first.requests.length,2);assert(first.currentProposalId);
 await syncRegularReplenishments({runId,planning:planning()});
 const second=(await listRegularReplenishments()).find(g=>g.itemId===itemId);
 assert.equal(second.currentProposalId,first.currentProposalId);
 const proposals=await query('SELECT count(*)::int AS n FROM scm_smart_proposals WHERE regular_replenishment_id=$1',[first.id]);
 assert.equal(proposals.rows[0].n,1);
});
test('draft quantities follow preferred gap, zero remains visible, explicit release stops carry',async()=>{
 await syncRegularReplenishments({runId,planning:planning(1000)});
 let group=(await listRegularReplenishments()).find(g=>g.itemId===itemId);assert.equal(group.quantity,200);
 await syncRegularReplenishments({runId,planning:planning(1300)});
 group=(await listRegularReplenishments()).find(g=>g.itemId===itemId);assert.equal(group.quantity,0);
 await releaseRegularReplenishment(group.id,{expectedRevision:group.revision},context);
 assert(!(await listRegularReplenishments()).some(g=>g.id===group.id));
 await syncRegularReplenishments({runId,planning:planning(800)});
 assert(!(await listRegularReplenishments()).some(g=>g.id===group.id));
});
test('priority load is carried into a later run without rewriting the placed order',async()=>{
 const request=await approved();await enqueueRegularReplenishments(request);
 await syncRegularReplenishments({runId,planning:planning()});
 const group=(await listRegularReplenishments()).find(g=>g.itemId===itemId);
 await query("UPDATE scm_smart_proposals SET status='completed',netsuite_purchase_order_id=999123,netsuite_purchase_order_ref='PO-fixture' WHERE id=$1",[group.currentProposalId]);
 const next=Number((await query("INSERT INTO scm_smart_planning_runs(trigger_source,status,settings_snapshot,plan_kind) VALUES('regular-test','ready','{}','inventory') RETURNING id")).rows[0].id);
 await syncRegularReplenishments({runId:next,planning:planning(1200)});
 const run=await getSmartScmPlanningRun(next);
 assert(run.regularReplenishments.some(g=>g.id===group.id));
 assert(run.proposals.some(p=>p.id===group.currentProposalId && p.regularReplenishmentId===group.id));
 assert.equal(Number((await query('SELECT sales_quantity FROM scm_smart_proposal_lines WHERE proposal_id=$1',[group.currentProposalId])).rows[0].sales_quantity),301);
 await releaseRegularReplenishment(group.id,{expectedRevision:(await listRegularReplenishments()).find(g=>g.id===group.id).revision},context);
});

test('real planner carries forced PO demand for an item with ordinary planning disabled',async()=>{
 const request=await approved();await enqueueRegularReplenishments(request);
 await query("INSERT INTO scm_smart_item_policies(item_id,item_name,to_plt,planning_enabled,pallet_weight_lbs) VALUES($1,'Paused priority fixture',1,false,20) ON CONFLICT(item_id) DO UPDATE SET planning_enabled=false",[itemId]);
 await query("INSERT INTO scm_smart_item_yard_policies(item_id,location_id,yard_code,eligible,capacity_pallets,minimum_safety_pallets) VALUES($1,1,'3445',true,2000,1200) ON CONFLICT(item_id,location_id) DO UPDATE SET minimum_safety_pallets=1200,capacity_pallets=2000",[itemId]);
 await query("UPDATE inventory_balances SET quantity_available=799,quantity_on_order=100,synced_at=now() WHERE item_id=$1 AND location_id=1",[itemId]);
 const run=await runSmartScmPlan({triggerSource:'regular-test',operatorId:actor});
 const group=run.regularReplenishments.find(g=>g.itemId===itemId);
 assert.equal(group.quantity,301);assert.ok(group.currentProposalId);
 assert.equal(run.proposals.filter(p=>p.lines.some(l=>l.itemId===itemId)).length,1);
 const next=await runSmartScmPlan({triggerSource:'regular-test',operatorId:actor});
 assert.equal(next.regularReplenishments.find(g=>g.itemId===itemId).currentProposalId,group.currentProposalId);
 await releaseRegularReplenishment(group.id,{expectedRevision:next.regularReplenishments.find(g=>g.id===group.id).revision},context);
});
test('a later PO-approved request shares the group but never changes its already ordered PO',async()=>{
 const first=await approved();await enqueueRegularReplenishments(first);await syncRegularReplenishments({runId,planning:planning()});
 const original=(await listRegularReplenishments()).find(g=>g.itemId===itemId);
 await query("UPDATE scm_smart_proposals SET status='completed',netsuite_purchase_order_id=999124 WHERE id=$1",[original.currentProposalId]);
 const later=await approved();await enqueueRegularReplenishments(later);
 await syncRegularReplenishments({runId,planning:planning(1000)});
 const group=(await listRegularReplenishments()).find(g=>g.itemId===itemId);
 assert.equal(group.id,original.id);assert.notEqual(group.currentProposalId,original.currentProposalId);assert.equal(group.quantity,200);
 assert.equal(Number((await query('SELECT sales_quantity FROM scm_smart_proposal_lines WHERE proposal_id=$1',[original.currentProposalId])).rows[0].sales_quantity),301);
 assert.equal(group.requests.length,2);
 await releaseRegularReplenishment(group.id,{expectedRevision:group.revision},context);
});
test('vendor staging carries its pending or placed child without duplicating a replenishment draft',async()=>{
 const request=await approved();await enqueueRegularReplenishments(request);await syncRegularReplenishments({runId,planning:planning()});
 const group=(await listRegularReplenishments()).find(g=>g.itemId===itemId);
 const child=Number((await query(`INSERT INTO scm_smart_proposals(run_id,proposal_key,proposal_type,phase,source_kind,source_name,destination_location_id,destination_name,status,parent_proposal_id,regular_replenishment_id,vendor_resolution_kind)
 SELECT run_id,proposal_key||'-review','PO',phase,source_kind,source_name,destination_location_id,destination_name,'confirmed',id,regular_replenishment_id,'netsuite_po_review' FROM scm_smart_proposals WHERE id=$1 RETURNING id`,[group.currentProposalId])).rows[0].id);
 await query('UPDATE scm_smart_proposal_lines SET proposal_id=$2 WHERE proposal_id=$1',[group.currentProposalId,child]);
 await query("UPDATE scm_smart_proposals SET status='superseded' WHERE id=$1",[group.currentProposalId]);
 const pending=await syncRegularReplenishments({runId,planning:planning()});
 assert.equal(pending.get(`${itemId}:1`),301);
 assert.equal((await listRegularReplenishments()).find(g=>g.id===group.id).currentProposalId,group.currentProposalId);
 await query("UPDATE scm_smart_proposals SET status='completed',netsuite_purchase_order_id=999125 WHERE id=$1",[child]);
 const placed=await syncRegularReplenishments({runId,planning:planning(1200)});
 assert.equal(placed.get(`${itemId}:1`)||0,0);
 assert.equal((await query('SELECT count(*)::int AS n FROM scm_smart_proposals WHERE regular_replenishment_id=$1',[group.id])).rows[0].n,2);
 await releaseRegularReplenishment(group.id,{expectedRevision:(await listRegularReplenishments()).find(g=>g.id===group.id).revision},context);
});
test('EA replenishment does not round a 301-unit gap up to four 100-unit pallets',async()=>{
 const request=await approved();await enqueueRegularReplenishments(request);
 const current=planning();current.states[0]={...state(),toPlt:100,preferred:12,positionPallets:8.99,policy:{...state().policy,to_plt:100,purchase_unit:'EA'}};
 await syncRegularReplenishments({runId,planning:current});
 const group=(await listRegularReplenishments()).find(g=>g.itemId===itemId);assert.equal(group.quantity,301);
 await releaseRegularReplenishment(group.id,{expectedRevision:group.revision},context);
});
test('forced quantity is credited against enabled ordinary planning and release wins a rebuild race',async()=>{
 await query('UPDATE scm_smart_item_policies SET planning_enabled=true WHERE item_id=$1',[itemId]);
 const request=await approved();await enqueueRegularReplenishments(request);
 const run=await runSmartScmPlan({triggerSource:'regular-test',operatorId:actor});
 const group=run.regularReplenishments.find(g=>g.itemId===itemId);
 assert.equal(run.proposals.filter(p=>p.lines.some(l=>l.itemId===itemId)).length,1);
 const outcomes=await Promise.allSettled([releaseRegularReplenishment(group.id,{expectedRevision:group.revision},context),runSmartScmPlan({triggerSource:'regular-test',operatorId:actor})]);
 // A stale explicit release is retried with its displayed fresh revision; a completed release is final.
 if(outcomes[0].status==='rejected'){
   assert.equal(outcomes[0].reason.status,409);const fresh=(await listRegularReplenishments()).find(g=>g.id===group.id);await releaseRegularReplenishment(group.id,{expectedRevision:fresh.revision},context);
 }
 const after=await runSmartScmPlan({triggerSource:'regular-test',operatorId:actor});
 assert(!after.regularReplenishments.some(g=>g.id===group.id));
 assert(!after.proposals.some(p=>p.regularReplenishmentId===group.id));
});
test('PO phase approval preserves priority replenishment for an item with ordinary planning paused',async()=>{
 const old=(await query('SELECT inventory_planning_mode FROM scm_smart_settings WHERE id=1')).rows[0].inventory_planning_mode;
 await query('UPDATE scm_smart_item_policies SET planning_enabled=false WHERE item_id=$1',[itemId]);
 await query("UPDATE scm_smart_settings SET inventory_planning_mode='po_then_transfer' WHERE id=1");
 let group;
 try{
   const request=await approved();await enqueueRegularReplenishments(request);
   const run=await runSmartScmPlan({triggerSource:'regular-test',operatorId:actor});
   group=run.regularReplenishments.find(group=>group.itemId===itemId);assert.equal(group.quantity,301);
   await approveSmartScmPoPhase(run.id,actor);
   const after=(await listRegularReplenishments()).find(candidate=>candidate.id===group.id);
   assert.equal(after.evidence.error,undefined);assert.equal(after.quantity,301);
 }finally{
   await query('UPDATE scm_smart_settings SET inventory_planning_mode=$1 WHERE id=1',[old]);
   if(group){const current=(await listRegularReplenishments()).find(candidate=>candidate.id===group.id);await releaseRegularReplenishment(group.id,{expectedRevision:current.revision},context);}
 }
});
test('missing fresh policy blocks order requests and priority material cannot be replaced',async()=>{
 const request=await approved();await enqueueRegularReplenishments(request);await syncRegularReplenishments({runId,planning:planning()});
 let group=(await listRegularReplenishments()).find(group=>group.itemId===itemId);
 await assert.rejects(()=>addSmartScmProposalLine(group.currentProposalId,{itemId,proposedPallets:1},actor),/keep their item/);
 await assert.rejects(()=>withTransaction(async()=>{
   await query("UPDATE scm_smart_proposals SET status='order_requested' WHERE id=$1",[group.currentProposalId]);
   await addSmartScmVendorAlternativeLine(group.currentProposalId,{itemId,proposedPallets:1},actor);
 }),/retain its approved item/);
 await syncRegularReplenishments({runId,planning:{...planning(),states:[]}});
 group=(await listRegularReplenishments()).find(candidate=>candidate.id===group.id);assert.match(group.evidence.error,/unavailable/);
 await assert.rejects(()=>updateSmartScmProposal(group.currentProposalId,{status:'order_requested'},actor),/unavailable/);
 assert.equal((await query('SELECT order_requested_at FROM scm_smart_proposals WHERE id=$1',[group.currentProposalId])).rows[0].order_requested_at,null);
 await syncRegularReplenishments({runId,planning:planning()});
 group=(await listRegularReplenishments()).find(candidate=>candidate.id===group.id);assert.equal(group.quantity,301);assert.equal(group.evidence.error,undefined);
 await releaseRegularReplenishment(group.id,{expectedRevision:group.revision},context);
});
test('replenishment requires every real TO commitment and can start without a prior ready planning run',async()=>{
 const request=await approved();await query("UPDATE regular_stock_handoffs SET plan='{\"mode\":\"transfer\"}',location_applied=false WHERE request_id=$1",[request.id]);
 await assert.rejects(()=>enqueueRegularReplenishments(request),/every TO commitment/);
 await convertSalesStockRequestLines(request.id,{expectedRevision:request.revision,lineIds:request.lines.map(line=>line.id)},{...context,approvedHandoff:true});
 let converted=await getScmStockRequest(request.id);await assert.rejects(()=>enqueueRegularReplenishments(converted),/every TO commitment/);
 await query('UPDATE sales_stock_transfers SET netsuite_transfer_order_id=id+9000000 WHERE request_id=$1',[request.id]);
 converted=await getScmStockRequest(request.id);await enqueueRegularReplenishments(converted);
 await assert.rejects(()=>withTransaction(async()=>{
   await query("UPDATE scm_smart_planning_runs SET status='failed' WHERE status='ready'");
   await syncRegularReplenishments({planning:planning()});
   const created=(await query("SELECT id FROM scm_smart_planning_runs WHERE status='ready' AND trigger_source='regular-stock-request'")).rows;
   assert.equal(created.length,1);
   const run=await getSmartScmPlanningRun(created[0].id);assert.equal(run.regularReplenishments.find(group=>group.itemId===itemId).quantity,301);
   throw new Error('ROLLBACK_ISOLATED_STARTUP_FIXTURE');
 }),/ROLLBACK_ISOLATED_STARTUP_FIXTURE/);
 const group=(await listRegularReplenishments()).find(group=>group.itemId===itemId);await releaseRegularReplenishment(group.id,{expectedRevision:group.revision},context);
});
