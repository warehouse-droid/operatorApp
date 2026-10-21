import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { normalizeSpecialCaseDraft } from '../../../src/special-stock-request-domain.js';
import { buildSpecialSalesOrderPayload } from '../../../src/special-stock-request-netsuite.js';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';
import { SPECIAL_STAGES } from '../../../public/special-stock-workflow.js';
import { defaultSpecialExpiry, normalizeSpecialExpiry } from '../../../public/special-stock-expiry.js';
import { parseVendorNames, vendorFilterHtml } from '../../../public/stock-request-vendor-filter.js';
const options={authorizedStoreLocationIds:[1],minimumRequiredDate:'2026-09-28'};
const input=()=>({storeLocationId:1,inquiryDate:'2026-09-28',customerName:'Original customer',vendorName:'Vendor',fulfillmentMethod:'yard_pickup',lines:[{productName:'Paver',color:'Buff',size:'12',detailSpec:'Honed edge',quantity:2,uom:'SQFT',rate:120,discountPercent:10,requiredDate:'2026-10-01',palletQty:1,layerQty:2,sectionQty:3,pieceQty:4}]});

test('request keeps Detail Spec and all pack counts without changing SQFT pricing',()=>{
 const d=normalizeSpecialCaseDraft(input(),options),l=d.lines[0];
 assert.equal(l.detailSpec,'Honed edge');assert.equal(l.uom,'SQFT');assert.equal(l.subtotal,216);
 assert.deepEqual([l.palletQty,l.layerQty,l.sectionQty,l.pieceQty],[1,2,3,4]);
 assert.equal(d.expiresOn,'2026-10-28');
});
test('pack counts reject negative, nonfinite and oversized values',()=>{
 for(const key of ['palletQty','layerQty','sectionQty','pieceQty'])for(const value of [-1,Infinity,'NaN',1e10]){
 const d=input();d.lines[0].uom='PCS';d.lines[0][key]=value;
 assert.throws(()=>normalizeSpecialCaseDraft(d,options),{code:'SPECIAL_PACK_QUANTITY_INVALID'});
 }
});
test('expiry defaults to a clamped calendar month and invalid dates are rejected',()=>{
 for(const [from,to]of [['2026-01-31','2026-02-28'],['2028-01-31','2028-02-29'],['2026-12-31','2027-01-31']])assert.equal(defaultSpecialExpiry(from),to);
 for(const value of ['2026-02-30','bad','2026-09-27'])assert.throws(()=>normalizeSpecialExpiry(value,'2026-09-28'),{code:'SPECIAL_EXPIRY_INVALID'});
 assert.equal(normalizeSpecialExpiry('2026-09-28','2026-09-28'),'2026-09-28');
});
test('property: pack payload is exact and does not change SO quantity, rate or total discount',()=>{
 fc.assert(fc.property(fc.array(fc.integer({min:0,max:10000}),{minLength:4,maxLength:4}),values=>{
 const [palletQty,layerQty,sectionQty,pieceQty]=values;
 const p=buildSpecialSalesOrderPayload({caseId:3,netsuiteLocationId:1,pickupMethodId:1,draft:{customerId:99,fulfillmentMethod:'yard_pickup',materialLines:[{itemId:2055,quantity:24,rate:10,nativeDiscountPercent:10,palletQty,layerQty,sectionQty,pieceQty}]}});
 const l=p.item.items[0];assert.deepEqual([l.custcol_plt,l.custcol_lyr,l.custcol_sec,l.custcol_pcs],values.map(value=>value===0?null:value));
 assert.equal(l.quantity,24);assert.equal(l.rate,10);assert.equal(p.discountRate,-24);assert.equal(p.entity.id,'99');
 }),{seed:9282026,numRuns:100});
});
test('quote labels special material, includes specification and uses selected rep and expiry with original customer',()=>{
 const d=input();d.lines[0].uom='PCS';Object.assign(d,{netsuiteSalesRepName:'Selected Rep',requestedByName:'Creator',expiresOn:'2026-11-01',netsuiteCustomerName:'Account lender'});
 d.lines[0].brand='Vendor';
 const q=buildSpecialQuote(d,{name:'Store',address:'Test',phone:'1',taxBps:1300,validityDays:30},{draft:true,operatorName:'Viewer'});
 assert.equal(q.snapshot.customerName,'Original customer');assert.equal(q.snapshot.salesRep,'Selected Rep');assert.equal(q.snapshot.validUntil,'2026-11-01');
 assert.equal(q.snapshot.lines[0].description,'MBBS-Special\nPaver Buff 12 Honed edge\nDiscount: 10%');
});
test('production stage names transfer without changing its key',()=>assert.equal(SPECIAL_STAGES.wait_for_production,'Wait for production / Transfer'));
test('vendor filters preserve exact punctuation, deduplicate and escape hostile names',()=>{
 assert.deepEqual(parseVendorNames(JSON.stringify(['A, Inc.','B','A, Inc.'])),['A, Inc.','B']);
 for(const value of ['not-json','{}',JSON.stringify([1]),JSON.stringify(Array(101).fill('A'))])assert.throws(()=>parseVendorNames(value),{code:'SPECIAL_VENDORS_INVALID'});
 const html=vendorFilterHtml(['A, Inc.','<img>'],['<img>']);assert.match(html,/&lt;img&gt;/);assert.doesNotMatch(html,/<img>/);assert.match(html,/checked/);
});

test('property: calendar expiry is exactly the next month with day clamped to its end',()=>{
 fc.assert(fc.property(fc.integer({min:2000,max:2199}),fc.integer({min:1,max:12}),fc.integer({min:1,max:31}),(year,month,day)=>{
 const start=new Date(Date.UTC(year,month-1,Math.min(day,new Date(Date.UTC(year,month,0)).getUTCDate())));
 const expiry=new Date(defaultSpecialExpiry(start.toISOString().slice(0,10))+'T12:00:00Z');
 assert.equal(expiry.getUTCFullYear()*12+expiry.getUTCMonth(),start.getUTCFullYear()*12+start.getUTCMonth()+1);
 assert.equal(expiry.getUTCDate(),Math.min(start.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate()));
 }),{seed:9282026,numRuns:100});
});
