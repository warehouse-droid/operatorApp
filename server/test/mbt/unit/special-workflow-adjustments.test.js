import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { specialNativeLinePricing,specialPalletQuantity } from '../../../public/special-stock-pricing.js';
import {specialOrderSnapshot} from '../../../src/special-stock-documents.js';
import { prepareSpecialMaterial } from '../../../src/special-stock-pricing-domain.js';
import { buildSpecialSalesOrderPayload, buildSpecialPurchaseOrderPayload } from '../../../src/special-stock-request-netsuite.js';

test('discounted material retains its gross converted unit rate',()=>{
  const line=prepareSpecialMaterial({itemId:2055,quantity:24,packageQuantity:2,conversionToPc:12,uom:'PC',rate:120,discountPercent:10},
    {originalRate:120,rateUom:'PLT',pricingSource:'enquiry'});
  assert.equal(line.rate,10); assert.equal(line.subtotal,216); assert.equal(line.discountPercent,10);
});

test('property: separate discount preserves gross price, percent endpoints and exact package total',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000}),fc.integer({min:1,max:100}),fc.integer({min:0,max:10000}),fc.integer({min:0,max:10000}),
    (quantity,conversion,rate,discount)=>{
      const result=specialNativeLinePricing({quantity,conversionToPc:conversion,rate:rate*conversion,discountPercent:discount/100});
      assert.equal(result.quantity,quantity*conversion);assert.equal(result.rate,rate);assert.equal(result.discountPercent,discount/100);
      const cents=BigInt(quantity*conversion*rate*100),expected=Number(cents-(cents*BigInt(discount)+5000n)/10000n)/100;
      assert.equal(result.subtotal,expected);
    }),{seed:260926,numRuns:500});
});
test('pallets require a bounded whole number and half-cent discounts use separate line rounding',()=>{
  for(const bad of [null,'',false,-1,1.1,1e9+1,'NaN'])assert.throws(()=>specialPalletQuantity(bad),{code:'SPECIAL_PALLET_INVALID'});
  assert.equal(specialPalletQuantity(0),0);assert.equal(specialPalletQuantity(1e9),1e9);
  assert.equal(specialNativeLinePricing({quantity:1,conversionToPc:1,rate:0.01,discountPercent:50}).subtotal,0);
});
test('a changed discount or remote adjustment status invalidates the native PDF snapshot',()=>{
  const d={salesOrderId:11,salesOrderLines:[{itemId:2055,quantity:2,rate:10,nativeDiscountPercent:10}],quantityReview:{id:'a',status:'pending'}};
  const before=specialOrderSnapshot(d,'sales_order','sales');
  d.salesOrderLines[0].nativeDiscountPercent=20;assert.notDeepEqual(specialOrderSnapshot(d,'sales_order','sales'),before);
  const pending=specialOrderSnapshot(d,'sales_order','sales');d.quantityReview.status='applying';
  assert.notDeepEqual(specialOrderSnapshot(d,'sales_order','sales'),pending);
});
test('each nonzero discount follows its own material and never discounts PALLET or PO',()=>{
  const materialLines=[{itemId:2055,description:'A',quantity:24,unitId:865,rate:10,discountPercent:12.5},
    {itemId:2055,description:'B',quantity:3,unitId:865,rate:20,discountPercent:0},
    {itemId:2055,description:'C',quantity:1,unitId:865,rate:30,discountPercent:100}];
  const payload=buildSpecialSalesOrderPayload({ discountMode: 'line',caseId:7,netsuiteLocationId:1,pickupMethodId:2,
    draft:{customerId:10,materialLines,ancillaryLines:[{itemId:1784,quantity:2,rate:40,unitId:246,description:'PALLET'}]}});
  assert.deepEqual(payload.item.items.map(x=>[x.item.id,x.rate]),[['2055',10],['10716',-30],['2055',20],['2055',30],['10716',-30],['1784',40]]);
  assert.equal('quantity' in payload.item.items[1],false); assert.equal('units' in payload.item.items[1],false);
  assert.equal(buildSpecialPurchaseOrderPayload({caseId:7,vendorId:5,netsuiteLocationId:1,lines:materialLines.map(x=>({...x,unitPurchaseCost:4}))}).item.items.length,3);
});
