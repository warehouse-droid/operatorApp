import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {query,closeDb} from '../../../src/db.js';
import {submitRegularStockRequest,decideRegularStockRequest,refreshRegularStockEvidence} from '../../../src/regular-stock-request-service.js';
import {addPurchaseStockProposals,releasePurchaseStockDemand} from '../../../src/regular-stock-purchase-service.js';
import {getScmStockRequest,getSalesStockRequest,listSalesStockRequests} from '../../../src/stock-request-repository.js';
import {refreshPurchaseStockAvailability,convertStockRequestLines} from '../../../src/stock-request-service.js';
const actor=`purchase-${Date.now()}`,itemId=9800000000081;
const context={operatorId:actor,authorizedDestinationLocationIds:[28],allowOverAvailability:false};
const dependencies={refreshAvailability:async()=>{throw new Error('Purchase must not refresh all yards');},loadPurchaseStock:async()=>({onHand:0,available:0,preferredStock:null}),
  loadPolicies:async()=>[],loadPurchasePolicy:async()=>({item_id:itemId,item_name:'Purchase fixture',stock_unit:'EA',to_plt:100,pallet_weight_lbs:1000,vendor_id:910001,vendor:'Purchase vendor',vendor_yard_id:910001,vendor_yard:'Purchase source',plant:'Purchase source'})};
const submit=(quantity=150)=>submitRegularStockRequest({deliveryMethod:'stocking',stockingType:'purchase',destinationLocationId:28,lines:[{itemId,pieces:quantity}]},context,dependencies);
before(async()=>{
  await query("INSERT INTO dispatch_vendor_yards(id,vendor,yard) VALUES(910001,'Purchase vendor','Purchase source') ON CONFLICT(id) DO NOTHING");
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)",[actor]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight,vendor_id,vendor) VALUES($1,'Purchase fixture','EA',1,100,10,910001,'Purchase vendor') ON CONFLICT(item_id) DO UPDATE SET to_plt=100,to_pcs=1",[itemId]);
});
after(closeDb);
test('source-less Purchase submits with zero stock, disabled override and no all-yard refresh',async()=>{
  const request=await submit();
  assert.equal(request.bucket,'pending'); assert.equal(request.regular.stockingType,'purchase');
  assert.equal(request.lines[0].sourceLocationId,null);assert.equal(request.regular.approval.automatic,false);
  assert.equal(request.lines[0].salesQty,150);assert.equal(request.lines[0].status,'submitted');
  await assert.rejects(()=>getSalesStockRequest(request.id,{...context,authorizedDestinationLocationIds:[1]}),e=>e.status===403);
});
test('SCM addition rounds upward, accepts once and creates a separate vendor PO with no transfers',async()=>{
  const request=await submit();
  const input={expectedRevision:request.revision,lines:[{lineId:request.lines[0].id,reviewedSalesQty:150}]};
  const accepted=await addPurchaseStockProposals(request.id,input,context,dependencies);
  assert.equal(accepted.bucket,'accepted');assert.equal(accepted.lines[0].salesQty,150);
  assert.equal(accepted.lines[0].purchase.approvedQuantity,200);assert.equal(accepted.lines[0].purchase.unorderedQuantity,200);
  assert.equal(accepted.transfers.length,0);
  const link=accepted.lines[0].purchase.proposals[0];
  const proposal=(await query('SELECT * FROM scm_smart_proposals WHERE id=$1',[link.proposalId])).rows[0];
  assert.equal(proposal.proposal_type,'PO');assert.equal(Number(proposal.source_vendor_yard_id),910001);
  const again=await addPurchaseStockProposals(request.id,input,context,dependencies);
  assert.equal(again.lines[0].purchase.demandId,accepted.lines[0].purchase.demandId);
  assert((await listSalesStockRequests({...context,bucket:'accepted'})).some(row=>row.id===request.id));
});
test('concurrent additions create one accepted demand and release only unordered quantity',async()=>{
  const request=await submit();
  const input={expectedRevision:request.revision,lines:[{lineId:request.lines[0].id,reviewedSalesQty:125}]};
  const results=await Promise.allSettled([addPurchaseStockProposals(request.id,input,context,dependencies),addPurchaseStockProposals(request.id,input,context,dependencies)]);
  assert(results.some(row=>row.status==='fulfilled'));
  assert.equal(Number((await query('SELECT count(*) AS n FROM regular_stock_purchase_demands WHERE request_line_id=$1',[request.lines[0].id])).rows[0].n),1);
  const accepted=await getScmStockRequest(request.id);
  const released=await releasePurchaseStockDemand(request.id,{expectedRevision:accepted.revision,lineIds:[request.lines[0].id],reason:'No longer required'},context);
  assert.equal(released.lines[0].purchase.releasedQuantity,200);assert.equal(released.lines[0].purchase.unorderedQuantity,0);
  assert.equal(released.bucket,'completed');
});
test('unmapped vendor or stale revision leaves the item pending with no allocation',async()=>{
  const request=await submit();
  const input={expectedRevision:request.revision,lines:[{lineId:request.lines[0].id}]};
  await assert.rejects(()=>addPurchaseStockProposals(request.id,input,context,{...dependencies,loadPurchasePolicy:async()=>null}),e=>e.status===409);
  await assert.rejects(()=>addPurchaseStockProposals(request.id,{...input,expectedRevision:99},context,dependencies),e=>e.status===409);
  assert.equal((await getScmStockRequest(request.id)).bucket,'pending');
});
test('Purchase stock refresh resolves and writes only the current yard, while missing evidence stays unavailable',async()=>{
  const calls=[];
  const result=await refreshPurchaseStockAvailability(itemId,28,{
    resolveYards:async yards=>{calls.push(yards);return [{netsuiteLocationId:700028}];},
    fetchBalances:async(items,yards)=>{calls.push({items,yards});return [{item_id:itemId,location_id:700028,quantity_available:5,quantity_on_hand:7},{item_id:itemId,location_id:700001,quantity_available:99}];},
    upsertBalances:async rows=>calls.push(rows)
  });
  assert.equal(result.yards.length,1);assert.equal(result.yards[0].locationId,28);
  assert.deepEqual(calls[0],[{locationId:28,code:'2967'}]);assert.deepEqual(calls[1],{items:[itemId],yards:[700028]});
  assert.equal(calls[2].length,1);assert.equal(calls[2][0].location_id,28);assert.equal(calls[2][0].quantity_available,5);
  await query(`INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,28,'2967',5,7,now())
    ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=5,quantity_on_hand=7,synced_at=now()`,[itemId]);
  await assert.rejects(()=>refreshPurchaseStockAvailability(itemId,28,{resolveYards:async()=>[{netsuiteLocationId:700028}],fetchBalances:async()=>[]}),/unavailable/);
  const request=await submit();
  const sales=await getSalesStockRequest(request.id,context);
  assert.equal(sales.availability[0].yards.length,1);assert.equal(sales.currentEvidence[0].onHand,7);assert.equal(sales.currentEvidence[0].available,5);
  const evidence=await refreshRegularStockEvidence(request.id,{loadPurchaseStock:async()=>{throw new Error('Current yard unavailable');}});
  assert.equal(evidence.currentEvidence[0].available,null);assert.equal(evidence.evidenceError,'Current yard unavailable');
});
test('accepted Purchase items cannot be rejected or converted through Transfer controls',async()=>{
  const request=await submit(),accepted=await addPurchaseStockProposals(request.id,{expectedRevision:request.revision,lines:[{lineId:request.lines[0].id}]},context,dependencies);
  await assert.rejects(()=>decideRegularStockRequest(request.id,{expectedRevision:accepted.revision,lineIds:[request.lines[0].id],decision:'reject',reason:'Must use release'},context,dependencies),e=>e.status===409);
  await assert.rejects(()=>convertStockRequestLines(request.id,{lineIds:[request.lines[0].id]},context,{getRequest:async()=>accepted,refreshAvailability:async()=>{throw new Error('Must not check other yards');}}),e=>e.status===409);
  assert.equal((await getScmStockRequest(request.id)).lines[0].purchase.approvedQuantity,200);
});
