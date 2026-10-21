import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { submitRegularStockRequest, decideRegularStockRequest, regularStockAlerts, acknowledgeRegularStockDecisions } from '../../../src/regular-stock-request-service.js';
import {listSalesStockRequests,listScmStockRequests} from '../../../src/stock-request-repository.js';
import {getSmartScmSettings,updateSmartScmSettings} from '../../../src/smart-scm-repository.js';
const seed = `regular-v2-${Date.now()}`;
const itemId = 9800000000001;
const context = { operatorId: seed, authorizedDestinationLocationIds: [28], allowOverAvailability: true };
const now = new Date('2026-09-29T14:00:00Z');
const input = (overrides = {}) => ({ destinationLocationId: 28, deliveryMethod: 'delivery', arrivalDate: '2026-09-29', arrivalTime: '15:00', lines: [{ itemId, sourceLocationId: 1, pieces: 200 }], ...overrides });
const dependencies = { now: () => now, refreshAvailability: async () => {}, loadPolicies: async () => [{ itemId, sourceLocationId: 1, availableQuantity: 1000, safetyQuantity: 800 }] };
before(async () => {
 await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)`,[seed]);
 await query(`INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,$2,'EA',1,100) ON CONFLICT(item_id) DO UPDATE SET to_pcs=1,to_plt=100`,[itemId,seed]);
 await query(`INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=1000`,[itemId]);
});
after(closeDb);
test('submission persists automatic approval evidence and creates no stock holds', async () => {
 const request=await submitRegularStockRequest(input(),context,dependencies);
 assert.equal(request.workflowVersion,2); assert.equal(request.lines[0].status,'approved');
 assert.equal(request.lines[0].decision,'stock'); assert.equal(request.lines[0].approvalEvidence.safetyQuantity,800);
 assert.equal(request.regular.arrivalTime,'15:00'); assert.equal(request.regular.approval.automatic,true);
 const result=await query('SELECT count(*)::int AS n FROM sales_stock_transfers WHERE request_id=$1',[request.id]);
 assert.equal(result.rows[0].n,0);
});
test('urgent request stays manual; per-item approval alerts only the original requester', async () => {
 const request=await submitRegularStockRequest(input({arrivalTime:'14:59'}),context,dependencies);
 assert.equal(request.lines[0].status,'submitted');
 const scm=await regularStockAlerts({scm:true}); assert(scm.manualReview>=1);
 const approved=await decideRegularStockRequest(request.id,{expectedRevision:request.revision,lineIds:[request.lines[0].id],decision:'po'},context,dependencies);
 assert.equal(approved.lines[0].decision,'po'); assert.equal(approved.lines[0].status,'approved');
 const own=await regularStockAlerts(context); assert(own.unread>=1);
 assert.equal((await regularStockAlerts({...context,operatorId:'someone-else'})).unread,0);
 assert.equal((await regularStockAlerts({...context,authorizedDestinationLocationIds:[1]})).unread,0);
});
test('rejection closes the case but remains an unread Sales decision; ack is bounded',async()=>{
 const request=await submitRegularStockRequest(input({arrivalTime:'11:00'}),context,dependencies);
 const rejected=await decideRegularStockRequest(request.id,{expectedRevision:request.revision,lineIds:[request.lines[0].id],decision:'reject',reason:'No supply'},context,dependencies);
 assert.equal(rejected.status,'completed'); assert.equal(rejected.lines[0].status,'rejected');
 assert(rejected.manualDecisionEventId>0);
 await acknowledgeRegularStockDecisions(request.id,{eventId:rejected.manualDecisionEventId},context);
 const alerts=await regularStockAlerts(context); assert(!alerts.requests.some(row=>row.id===request.id));
 await assert.rejects(()=>acknowledgeRegularStockDecisions(request.id,{eventId:rejected.manualDecisionEventId+99999},context),e=>e.status===409);
});
test('two SCM decisions with the same revision cannot both succeed',async()=>{
 const request=await submitRegularStockRequest(input({arrivalTime:'11:00'}),context,dependencies);
 const payload={expectedRevision:request.revision,lineIds:[request.lines[0].id],decision:'stock'};
 const results=await Promise.allSettled([decideRegularStockRequest(request.id,payload,context,dependencies),decideRegularStockRequest(request.id,payload,context,dependencies)]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
});
test('missing mandatory fields and forbidden Sales yard make no request',async()=>{
 await assert.rejects(()=>submitRegularStockRequest(input({deliveryMethod:''}),context,dependencies),e=>e.status===400);
 await assert.rejects(()=>submitRegularStockRequest(input(),{...context,authorizedDestinationLocationIds:[1]},dependencies),e=>e.status===403);
});
test('approved requests remain visible in Sales Accepted and SCM awaiting SO queues',async()=>{
 const request=await submitRegularStockRequest(input(),context,dependencies);
 assert((await listSalesStockRequests({...context,bucket:'accepted'})).some(row=>row.id===request.id));
 assert((await listScmStockRequests({queue:'approved'})).some(row=>row.id===request.id));
});
test('configurable lead time changes only new submissions',async()=>{
 const original=await getSmartScmSettings();
 try {
  const saved=await updateSmartScmSettings({regularStockLeadHours:6.5},seed);
  assert.equal(saved.regularStockLeadHours,6.5);
  const request=await submitRegularStockRequest(input(),context,dependencies);
  assert.equal(request.regular.approval.automatic,false);
  await updateSmartScmSettings({regularStockLeadHours:0},seed);
  assert.equal((await submitRegularStockRequest(input(),context,dependencies)).regular.approval.automatic,true);
  assert.equal(request.regular.approval.leadHours,6.5);
  await assert.rejects(()=>updateSmartScmSettings({regularStockLeadHours:-1},seed),e=>e.status===400);
 } finally {await updateSmartScmSettings({regularStockLeadHours:original.regularStockLeadHours??5},seed);}
});
test('editing an undecided request reruns approval but an approved request stays locked',async()=>{
 const {editRegularStockRequest}=await import('../../../src/regular-stock-request-service.js');
 const r=await submitRegularStockRequest(input({arrivalTime:'11:00'}),context,dependencies);
 const updated=await editRegularStockRequest(r.id,{...input(),expectedRevision:r.revision,lines:[{id:r.lines[0].id,itemId,sourceLocationId:1,pieces:200}]},context,dependencies);
 assert.equal(updated.regular.approval.automatic,true);assert.equal(updated.lines[0].status,'approved');
 await assert.rejects(()=>editRegularStockRequest(r.id,{...input(),expectedRevision:updated.revision},context,dependencies),e=>e.status===409);
});
test('optional customer validation preserves directory identity and rejects invalid names',async()=>{
 const id=98000040;
 await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1,'REGULAR-FIXTURE','Regular Customer','Regular Customer','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING",[id]);
 const r=await submitRegularStockRequest(input({customerId:id,customerName:'ignored'}),context,dependencies);
 assert.equal(Number(r.regular.customerId),id);assert.match(r.regular.customerName,/Regular Customer/);
 await assert.rejects(()=>submitRegularStockRequest(input({customerName:'x'.repeat(201)}),context,dependencies),e=>e.status===400);
 await assert.rejects(()=>submitRegularStockRequest(input({customerId:999999999}),context,dependencies),e=>e.status===400);
});
