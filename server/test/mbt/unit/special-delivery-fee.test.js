import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {normalizeSpecialCaseDraft,normalizeSpecialSalesOrderDraft,matchSpecialOrderCoverage} from '../../../src/special-stock-request-domain.js';
import {buildSpecialQuote} from '../../../src/special-stock-documents.js';
import {buildSpecialSalesOrderPayload,buildSpecialPurchaseOrderPayload} from '../../../src/special-stock-request-netsuite.js';
import {copySpecialRequestDraft} from '../../../public/special-stock-request-actions.js';
import {specialRequestPalletLine} from '../../../public/special-stock-pallet-display.js';
import {resolveSpecialUnits} from '../../../src/special-stock-netsuite-adapter.js';
import {createSpecialSalesRepDirectory} from '../../../src/special-stock-sales-reps.js';
const detail=()=>({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Customer',vendorName:'TEST Vendor',fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST Address',palletTotal:3,palletRate:40,deliveryFeeRate:235,
 lines:[{id:10,productName:'Stone',quantity:2,packageQuantity:2,uom:'PCS',rateUom:'PCS',rate:100,originalRate:100,discountPercent:10,requiredDate:'2099-02-01'}],salesOrderLines:[]});
const normalize=input=>normalizeSpecialCaseDraft(input,{authorizedStoreLocationIds:[1],minimumRequiredDate:'2099-01-01'});
const draft=()=>({...detail(),customerId:2008,operationalYardLocationId:1,materialLines:[{caseLineId:10,itemId:2055,description:'Stone',quantity:2,uom:'PC',rate:100,discountPercent:10}]});
const profile={name:'TEST Company',taxBps:1300,validityDays:30};
test('Sales rate is normalized and copied, including free delivery',()=>{
 for(const rate of [235,0,12.123456]){const input={...detail(),deliveryFeeRate:String(rate)};assert.equal(normalize(input).deliveryFeeRate,rate);assert.equal(Number(copySpecialRequestDraft(input).deliveryFeeRate),rate);}
});
test('invalid delivery rates are rejected and pickup discards hidden delivery rates',()=>{
 for(const rate of [-1,'',true,{},[],NaN,Infinity,1e9+1,.1234567,'bad'])assert.throws(()=>normalize({...detail(),deliveryFeeRate:rate}),{code:'SPECIAL_DELIVERY_FEE_INVALID'});
 for(const fulfillmentMethod of ['yard_pickup','vendor_pickup'])assert.equal(normalize({...detail(),fulfillmentMethod}).deliveryFeeRate,null);
});
test('quote and SO add one undiscounted paid customer fee and omit a zero fee',()=>{
 for(const rate of [235,0]){
  const input={...detail(),deliveryFeeRate:rate};const quote=buildSpecialQuote(input,profile);
  const quotedFee=quote.snapshot.lines.filter(l=>l.description==='Delivery Charge');assert.equal(quotedFee.length,rate>0?1:0);if(rate>0)assert.equal(quotedFee[0].amountMinor,rate*100);
  assert.equal(quote.snapshot.subtotalMinor,30000+rate*100);assert.equal(quote.snapshot.discountMinor,2000);
  const order=normalizeSpecialSalesOrderDraft({...draft(),deliveryFeeRate:rate});const fee=order.ancillaryLines.filter(l=>l.itemId===1987);assert.equal(fee.length,rate>0?1:0);if(rate>0){assert.equal(fee[0].quantity,1);assert.equal(fee[0].rate,rate);assert.equal(fee[0].uom,null);}
  const so=buildSpecialSalesOrderPayload({caseId:95,draft:order,netsuiteLocationId:1,deliveryMethodId:1,pickupMethodId:2});assert.equal(so.item.items.filter(l=>l.item.id==='1987').length,rate>0?1:0);
  const po=buildSpecialPurchaseOrderPayload({caseId:95,vendorId:331,netsuiteLocationId:1,lines:order.materialLines});assert.equal(po.item.items.filter(l=>l.item.id==='1987').length,0);
 }
});
test('managed fee replaces stale ancillary duplicates and pickup removes the managed charge',()=>{
 const stale=[{itemId:1987,ancillary:true,description:'Delivery Charge',quantity:1,rate:999,uom:null}];
 const order=normalizeSpecialSalesOrderDraft({...draft(),ancillaryLines:[...stale,...stale]});assert.deepEqual(order.ancillaryLines.filter(l=>l.itemId===1987).map(l=>l.rate),[235]);
 const quote=buildSpecialQuote({...detail(),salesOrderLines:[{caseLineId:10},...stale,...stale]},profile);assert.equal(quote.snapshot.lines.filter(l=>l.description==='Delivery Charge').length,1);assert.equal(quote.snapshot.subtotalMinor,53500);
 const pickup=normalizeSpecialSalesOrderDraft({...draft(),fulfillmentMethod:'yard_pickup',ancillaryLines:stale});assert.equal(pickup.ancillaryLines.filter(l=>l.itemId===1987).length,0);
});
test('saved fee displays below PALLET and remains visible when no pallets are needed',()=>{
 const html=specialRequestPalletLine(detail());assert.match(html,/data-special-delivery-fee-line/);assert.ok(html.indexOf('data-special-delivery-fee-line')>html.indexOf('data-special-pallet-line'));assert.match(html,/235\.00/);
 assert.match(specialRequestPalletLine({...detail(),palletTotal:0}),/235\.00/);assert.doesNotMatch(specialRequestPalletLine({...detail(),fulfillmentMethod:'yard_pickup'}),/data-special-delivery-fee-line/);
});
test('legacy delivery charges retain their quantities and amounts on quotes',()=>{
 const input=detail();delete input.deliveryFeeRate;
 input.salesOrderLines=[{caseLineId:10},{itemId:1987,ancillary:true,description:'Existing delivery',quantity:2,rate:100,uom:null}];
 const quote=buildSpecialQuote(input,profile),line=quote.snapshot.lines.find(l=>l.description==='Existing delivery');
 assert.equal(line?.quantity,'2');assert.equal(line?.amountMinor,20000);assert.equal(quote.snapshot.subtotalMinor,50000);
});
test('copying legacy delivery charges preserves the full customer amount as one editable fee',()=>{
 const input=detail();delete input.deliveryFeeRate;
 input.salesOrderLines=[{itemId:1987,ancillary:true,quantity:2,rate:100},{itemId:1987,ancillary:true,quantity:1,rate:35}];
 assert.equal(copySpecialRequestDraft(input).deliveryFeeRate,235);
 assert.match(specialRequestPalletLine(input),/235\.00/);
});
test('unitless Delivery Charge is supported without weakening unit checks for materials',async()=>{
 const boundary={queryAll:async()=>[{id:1987,unitstype:null}],rest:async()=>{throw Error('No units list needed');}};
 assert.deepEqual(await resolveSpecialUnits([{itemId:1987,uom:null,quantity:1,rate:235}],boundary),[{itemId:1987,uom:null,quantity:1,rate:235}]);
 await assert.rejects(resolveSpecialUnits([{itemId:2055,uom:'PC',quantity:1,rate:20}],boundary),{code:'SPECIAL_UOM_INVALID'});
});
test('property: entered cents add once to quotes, never to PO lines or PO matching',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:10000000}),(paidCents)=>{
  for (const cents of [0,paidCents]) {
   const input={...detail(),deliveryFeeRate:cents/100};const quote=buildSpecialQuote(input,profile),base=30000n+BigInt(cents);
   assert.equal(quote.snapshot.subtotalMinor,Number(base));assert.equal(quote.snapshot.totalMinor,Number(base+(base*1300n+5000n)/10000n));
   assert.equal(quote.snapshot.lines.filter(l=>l.description==='Delivery Charge').length,cents>0?1:0);
   const order=normalizeSpecialSalesOrderDraft({...draft(),deliveryFeeRate:cents/100});assert.equal(order.ancillaryLines.find(l=>l.itemId===1987)?.rate,cents>0?cents/100:undefined);
   const poLines=order.materialLines.map((l,i)=>({...l,id:i+1,itemName:'MBBS-Special Order'}));
   assert.equal(buildSpecialPurchaseOrderPayload({caseId:95,vendorId:1,netsuiteLocationId:1,lines:poLines}).item.items.length,1);
   assert.equal(matchSpecialOrderCoverage(poLines,poLines.map(l=>({...l,lineId:l.id})),{orderKind:'Purchase Order'}).length,1);
  }
 }),{seed:2026100181,numRuns:200});
});
test('local submission selection uses the verified directory without another network call and survives restart',async()=>{
 let calls=0,cached=null;
 const deps={queryAll:async()=>{calls++;return [{id:123,name:'Verified rep'}];},saveCache:async reps=>{cached=reps;},loadCache:async()=>cached};
 const first=createSpecialSalesRepDirectory(deps);await first.list();assert.equal(calls,1);
 for(const directory of [first,createSpecialSalesRepDirectory({...deps,queryAll:async()=>{throw Error('Submission must be local');}})])assert.deepEqual(await directory.select(123,{localOnly:true}),{id:123,name:'Verified rep'});
 assert.equal(calls,1);await assert.rejects(first.select(999,{localOnly:true}),{code:'SPECIAL_SALES_REP_REQUIRED'});assert.equal(calls,1);
});


test('zero delivery hides the request line and stale quote/SO charge but preserves the entered zero and other free items',()=>{
  const input={...detail(),deliveryFeeRate:0,salesOrderLines:[{caseLineId:10},{itemId:1987,ancillary:true,description:'Stale paid delivery',quantity:1,rate:235,uom:null}]};
  assert.doesNotMatch(specialRequestPalletLine(input),/data-special-delivery-fee-line/);
  assert.equal(copySpecialRequestDraft(input).deliveryFeeRate,0);
  const quote=buildSpecialQuote(input,profile);assert.equal(quote.snapshot.lines.filter(l=>l.itemId===1987||/delivery/i.test(l.description)).length,0);
  assert.equal(quote.snapshot.subtotalMinor,30000);
  const order=normalizeSpecialSalesOrderDraft({...draft(),deliveryFeeRate:0,ancillaryLines:input.salesOrderLines.filter(l=>l.ancillary)});
  assert.equal(order.deliveryFeeRate,0);assert.equal(order.ancillaryLines.filter(l=>l.itemId===1987).length,0);
  const legacy={...draft(),ancillaryLines:[{itemId:1987,description:'Delivery Charge',quantity:1,rate:0,uom:null},{itemId:2000,description:'Free sample',quantity:1,rate:0,uom:'EACH'}]};
  const payload=buildSpecialSalesOrderPayload({caseId:95,draft:legacy,netsuiteLocationId:1,deliveryMethodId:1,pickupMethodId:2});
  assert.equal(payload.item.items.filter(l=>l.item.id==='1987').length,0);assert.equal(payload.item.items.filter(l=>l.item.id==='2000').length,1);
  const historical={...input};delete historical.deliveryFeeRate;historical.salesOrderLines=[{caseLineId:10},{itemId:1987,ancillary:true,description:'Zero delivery',quantity:1,rate:0,uom:null}];
  assert.equal(buildSpecialQuote(historical,profile).snapshot.lines.filter(l=>/delivery/i.test(l.description)).length,0);
});
