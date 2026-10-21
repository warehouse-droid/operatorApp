/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {canAddSpecialItems,copySpecialRequestDraft} from '../../../public/special-stock-request-actions.js';
import * as domain from '../../../src/special-stock-request-domain.js';

const today='2026-10-01';
const source=()=>({id:41,requestRef:'SPREQ-000041',revision:9,stage:'await_customer_confirmation',closeStatus:'active',storeLocationId:28,
 customerId:77,customerName:'Customer <One>',customerPhone:'555-0100',vendorId:331,vendorName:'Vendor One',
 inquiryDate:'2026-09-01',expiresOn:'2026-09-30',netsuiteSalesRepId:123,estimateId:88,remarks:'Keep gate closed',
 fulfillmentMethod:'mbt_delivery',deliveryAddress:'10 Main',deliveryContactName:'Sam',deliveryContactPhone:'555-0101',
 deliveryDate:'2026-10-12',windowStart:'09:00',windowEnd:'12:00',deliveryInstructions:'Use side gate',
 lines:[{id:90,productName:'Stone',brand:'Vendor One',color:'Buff',size:'12',detailSpec:'Honed edge',quantity:2,uom:'PLT',originalRate:12.25,
 discountPercent:10,palletQty:2,layerQty:3,sectionQty:4,pieceQty:5,requiredDate:'2026-10-12',customerNote:'Ask first',estimateLineReference:'6',
 supplyStatus:'in_stock',salesDecision:'accepted',unitPurchaseCost:8,responseRevision:3,itemResolution:{itemId:2055}}]});
const copy=record=>copySpecialRequestDraft(record,{today,expiresOn:'2026-11-01'});
const line=()=>({productName:'New paver',quantity:3,uom:'PCS',rate:0,discountPercent:0,requiredDate:'2026-10-12'});

test('Add item is available only before orders and remote submissions on an active request',()=>{
 assert.equal(canAddSpecialItems(source()),true);
 for(const patch of [{closeStatus:'closed'},{closeStatus:'closure_pending'},{operationallyComplete:true},{salesOrderId:12},
 {purchaseOrderId:13},{salesOrderSkipped:true},{purchaseOrderSkipped:true},{salesOrderOperationStatus:'creating'},
 {salesOrderOperationStatus:'attention'},{purchaseOrderOperationStatus:'creating'},{salesOrderSubmissionStartedAt:'2026-10-01'},
 {purchaseOrderSubmissionStartedAt:'2026-10-01'},{quantityReviewPending:true},{fulfillmentChange:{status:'pending'}},{attention:true}]) {
  assert.equal(canAddSpecialItems({...source(),...patch}),false,JSON.stringify(patch));
 }
 assert.equal(canAddSpecialItems(null),false);
});
test('copy closed request preserves business fields and prices in an independent draft without order or stock state',()=>{
 const record={...source(),closeStatus:'closed',salesOrderId:100,purchaseOrderId:200};const original=structuredClone(record),draft=copy(record);
 for(const field of ['customerName','customerPhone','vendorName','remarks','fulfillmentMethod','deliveryAddress','deliveryContactName','deliveryContactPhone','deliveryDate','windowStart','windowEnd','deliveryInstructions'])assert.equal(draft[field],record[field]);
 assert.equal(draft.storeLocationId,'28');assert.equal(draft.customerId,'77');assert.equal(draft.vendorId,'331');assert.equal(draft.salesRepId,'123');
 assert.equal(draft.selectedCustomerName,record.customerName);assert.equal(draft.selectedCustomerPhone,record.customerPhone);assert.equal(draft.selectedVendorName,record.vendorName);
 assert.equal(draft.inquiryDate,today);assert.equal(draft.expiresOn,'2026-11-01');assert.equal(draft.estimateId,'88');
 for(const field of ['productName','brand','color','size','detailSpec','quantity','uom','discountPercent','palletQty','layerQty','sectionQty','pieceQty','requiredDate','customerNote','estimateLineReference'])assert.equal(draft.lines[0][field],record.lines[0][field]);
 assert.equal(draft.lines[0].rate,12.25);assert.ok(draft.lines[0].key);
 for(const field of ['id','requestRef','revision','stage','closeStatus','salesOrderId','purchaseOrderId'])assert.equal(Object.hasOwn(draft,field),false,field);
 for(const field of ['id','supplyStatus','salesDecision','itemResolution','unitPurchaseCost','responseRevision'])assert.equal(Object.hasOwn(draft.lines[0],field),false,field);
 draft.lines[0].productName='Edited';assert.deepEqual(record,original);
});
test('additional items use original line validation, limits and vendor scope instead of supplied stock/order state',()=>{
 const normalize=domain.normalizeSpecialAdditionalLines;assert.equal(typeof normalize,'function');
 assert.deepEqual(normalize([line()],{existingLineCount:99,minimumRequiredDate:today})[0].productName,'New paver');
 for(const [items,count] of [[[],1],[[line(),line()],99],[[line()],100],[null,1],[[line()],-1],[[line()],1.5]])assert.throws(()=>normalize(items,{existingLineCount:count,minimumRequiredDate:today}),{code:'SPECIAL_CASE_LINES_INVALID'});
 for(const patch of [{quantity:0},{quantity:Infinity},{quantity:1e9+1},{uom:'EA'},{productName:''},{rate:-1},{discountPercent:101},{palletQty:-1},{requiredDate:'2026-09-30'},{requiredDate:'2026-02-30'}])assert.throws(()=>normalize([{...line(),...patch}],{existingLineCount:1,minimumRequiredDate:today}));
 const normalized=normalize([{...line(),supplyStatus:'in_stock',salesDecision:'accepted',itemResolution:{itemId:7},id:1}],{existingLineCount:1,minimumRequiredDate:today})[0];
 assert.equal(Object.hasOwn(normalized,'supplyStatus'),false);assert.equal(Object.hasOwn(normalized,'id'),false);
});
test('property: copying arbitrary item descriptions, prices and packages preserves every entered value without aliasing or order state',()=>{
 fc.assert(fc.property(fc.array(fc.record({productName:fc.string({maxLength:40}),color:fc.string({maxLength:20}),size:fc.string({maxLength:20}),detailSpec:fc.string({maxLength:40}),quantity:fc.integer({min:1,max:1e6}),originalRate:fc.integer({min:0,max:1e6}),discountPercent:fc.integer({min:0,max:100}),palletQty:fc.integer({min:0,max:1000})}),{minLength:1,maxLength:100}),items=>{
  const record={...source(),lines:items.map(item=>({...source().lines[0],...item}))};const before=JSON.stringify(record),draft=copy(record);
  assert.equal(draft.lines.length,items.length);assert.equal(new Set(draft.lines.map(item=>item.key)).size,items.length);
  draft.lines.forEach((item,index)=>{for(const field of ['productName','color','size','detailSpec','quantity','discountPercent','palletQty'])assert.equal(item[field],record.lines[index][field]);assert.equal(item.rate,record.lines[index].originalRate);assert.equal(Object.hasOwn(item,'id'),false);});
  draft.lines[0].productName+=' changed';assert.equal(JSON.stringify(record),before);
 }),{seed:2026100141,numRuns:150});
});
test('property: append count is bounded on both sides and valid batches keep names and commercial values',()=>{
 assert.equal(typeof domain.normalizeSpecialAdditionalLines,'function');
 fc.assert(fc.property(fc.integer({min:1,max:100}),fc.integer({min:0,max:100}),fc.integer({min:1,max:1e9}),fc.integer({min:0,max:1e6}),(oldCount,addCount,quantity,rate)=>{
  const items=Array.from({length:addCount},(_,index)=>({...line(),productName:'Item '+index,quantity,rate}));
  if(addCount===0||oldCount+addCount>100){assert.throws(()=>domain.normalizeSpecialAdditionalLines(items,{existingLineCount:oldCount,minimumRequiredDate:today}),{code:'SPECIAL_CASE_LINES_INVALID'});return;}
  if(BigInt(quantity)*BigInt(rate)*100n>BigInt(Number.MAX_SAFE_INTEGER)){assert.throws(()=>domain.normalizeSpecialAdditionalLines(items,{existingLineCount:oldCount,minimumRequiredDate:today}),{code:'SPECIAL_SUBTOTAL_INVALID'});return;}
  const normalized=domain.normalizeSpecialAdditionalLines(items,{existingLineCount:oldCount,minimumRequiredDate:today});assert.equal(normalized.length,addCount);
  normalized.forEach((item,index)=>{assert.equal(item.productName,items[index].productName);assert.equal(item.quantity,quantity);assert.equal(item.rate,rate);});
 }),{seed:2026100142,numRuns:150});
});
