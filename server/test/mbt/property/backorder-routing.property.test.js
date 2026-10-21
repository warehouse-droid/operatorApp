import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {normalizeSpecialCaseDraft} from '../../../src/special-stock-request-domain.js';
const draft=lines=>({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'',vendorName:'TEST vendor',fulfillmentMethod:'yard_pickup',lines});
const material=(yard,vendor,index)=>({regularItemId:900000+index,regularItemCode:'TEST-'+index,brand:'TEST vendor '+vendor,regularVendorId:vendor,destinationLocationId:yard,productName:'Material '+index,quantity:index+1,rate:0,uom:'EA',requiredDate:'2099-02-01'});
test('Backorder routing normalization preserves independently selected yards, vendors and item identity',()=>{
  fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom(1,28,15,26),fc.integer({min:1,max:1e6})),{minLength:1,maxLength:25}),routes=>{
    const lines=routes.map(([yard,vendor],i)=>material(yard,vendor,i));
    const normalized=normalizeSpecialCaseDraft(draft(lines),{workflowKind:'backorder',authorizedStoreLocationIds:[1,28,15,26],minimumRequiredDate:'2099-01-01'});
    assert.deepEqual(normalized.lines.map(l=>[l.destinationLocationId,l.regularVendorId,l.regularItemId]),routes.map(([yard,vendor],i)=>[yard,vendor,900000+i]));
  }),{seed:20261007,numRuns:200});
});
test('Backorder routing normalization refuses invalid line identity fields without changing valid neighbors',()=>{
  fc.assert(fc.property(fc.integer({min:-1e6,max:0}),invalid=>{
    for(const field of ['destinationLocationId','regularVendorId'])assert.throws(()=>normalizeSpecialCaseDraft(draft([material(1,331,0),{...material(28,332,1),[field]:invalid}]),{workflowKind:'backorder',authorizedStoreLocationIds:[1,28],minimumRequiredDate:'2099-01-01'}));
  }),{seed:7,numRuns:100});
});
