import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeStockingType,purchaseReviewQuantity,allocatePurchaseQuantity} from '../../../src/regular-stock-purchase-domain.js';

test('omitted mode preserves Transfer; Purchase is exclusive to Stocking',()=>{
  assert.equal(normalizeStockingType('stocking'), 'transfer');
  assert.equal(normalizeStockingType('stocking','purchase'), 'purchase');
  assert.throws(()=>normalizeStockingType('pickup','purchase'),{status:400});
  assert.throws(()=>normalizeStockingType('stocking','invalid'),{status:400});
});
test('SCM review always rounds up while retaining the requested and reviewed quantities',()=>{
  assert.deepEqual(purchaseReviewQuantity(150,100,125),{requestedQuantity:150,reviewedQuantity:125,approvedPallets:2,approvedQuantity:200,toPlt:100});
  assert.equal(purchaseReviewQuantity(200,100).approvedPallets,2);
  assert.equal(purchaseReviewQuantity(200.01,100).approvedPallets,3);
  assert.equal(purchaseReviewQuantity(200.000001,100).approvedPallets,3);
  assert.equal(purchaseReviewQuantity(0.3,0.1).approvedPallets,3);
  assert.equal(purchaseReviewQuantity(0.07,0.01).approvedPallets,7);
});
test('invalid quantity or absent conversion cannot create Purchase demand',()=>{
  for(const value of [0,-1,NaN,Infinity,1000000001]) assert.throws(()=>purchaseReviewQuantity(value,100));
  for(const conversion of [0,null,-1,Infinity]) assert.throws(()=>purchaseReviewQuantity(150,conversion));
});
test('shared PO/receipt capacity is conserved and awarded in acceptance order',()=>{
  const demands=[{id:1,remaining:2},{id:2,remaining:3}];
  assert.deepEqual(allocatePurchaseQuantity(demands,4,3),[
    {demandId:1,quantity:2,received:2},{demandId:2,quantity:2,received:1}
  ]);
  assert.deepEqual(allocatePurchaseQuantity(demands,1,7),[{demandId:1,quantity:1,received:1}]);
  assert.deepEqual(allocatePurchaseQuantity(demands,0,0),[]);
});
