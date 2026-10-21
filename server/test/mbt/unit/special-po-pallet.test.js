import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import * as pricing from '../../../public/special-stock-purchase-pricing.js';
import { buildSpecialPurchaseOrderPayload } from '../../../src/special-stock-request-netsuite.js';

const materials = [{caseLineId:1,itemId:2055,quantity:24,unitPurchaseCost:33.87,vendorDiscountPercent:10}];
const payload = (pallet) => buildSpecialPurchaseOrderPayload({caseId:83,vendorId:331,netsuiteLocationId:1,
  lines:[...materials, ...(pallet ? [pallet] : [])],vendorDiscountReview:pricing.specialVendorLineDiscountReview(materials)});

test('PALLET uses reviewed purchase cost independently of the SO rate and zero omits it', () => {
  const pallet = pricing.specialPurchasePalletLine({quantity:'2',unitPurchaseCost:'35'});
  assert.deepEqual(pallet,{itemId:1784,ancillary:true,description:'PALLET',quantity:2,uom:'EACH',unitPurchaseCost:35});
  assert.equal(pricing.specialPurchasePalletLine({quantity:0,unitPurchaseCost:''}),null);
});

test('PALLET rejects missing, hostile and fractional inputs, and requires cost only for positive quantity', () => {
  for (const quantity of [undefined,null,'',' ',false,true,-1,0.5,Infinity,NaN,1e9+1,[],{}]) {
    assert.throws(() => pricing.specialPurchasePalletLine({quantity,unitPurchaseCost:35}),{code:'SPECIAL_PALLET_INVALID'});
  }
  for (const unitPurchaseCost of [undefined,null,'',' ',false,-1,Infinity,1e9+1,0.0000001]) {
    assert.throws(() => pricing.specialPurchasePalletLine({quantity:1,unitPurchaseCost}),{code:'SPECIAL_RATE_INVALID'});
  }
  assert.equal(pricing.specialPurchasePalletLine({quantity:1,unitPurchaseCost:0}).unitPurchaseCost,0);
});

test('PO payload includes PALLET exactly once and excludes it from the material vendor discount', () => {
  const p = payload({itemId:1784,ancillary:true,quantity:1,uom:'EACH',unitId:3,unitPurchaseCost:35,description:'PALLET'});
  assert.deepEqual(p.item.items.map(line=>[line.item.id,line.quantity,line.rate]),[['2055',24,33.87],['1784',1,35],['4981',1,-81.29]]);
  assert.equal(p.item.items[1].units,'3');
  assert.equal(p.externalId,'MBBS-SPECIAL-PO:83');
  assert.equal(p.createdFrom,undefined);
});

test('property: PALLET count and cost never change the materials or their discount', () => {
  fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.integer({min:0,max:10000000}), (quantity,costCents) => {
    const pallet=pricing.specialPurchasePalletLine({quantity,unitPurchaseCost:costCents/100});
    const p=payload(pallet), without=payload(null);
    assert.deepEqual(p.item.items[0],without.item.items[0]);
    assert.deepEqual(p.item.items.at(-1),without.item.items.at(-1));
    assert.equal(p.item.items.filter(line=>line.item.id==='1784').length,1);
    assert.deepEqual([p.item.items[1].quantity,p.item.items[1].rate],[quantity,costCents/100]);
  }),{seed:2026093017,numRuns:200});
});
