import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import * as access from '../../../src/regular-stock-delivery-access.js';

const request = (source,destination) => ({requestType:'regular',workflowVersion:2,destinationLocationId:destination,
  regular:{deliveryMethod:'delivery',deliveryVersion:1,sourceLocationId:source}});

test('2967 Sales may open Delivery with Target Yard 2967 and Base Yard 3445', () => {
  assert.equal(access.assertDeliveryStockRequestDestinationAccess(28,1,[28]),1);
  assert.equal(access.assertDeliveryStockRequestDestinationAccess('28','1',['28']),1);
});

test('every Sales account can discover the opposite SO Base Yard before selecting a target', () => {
  for (const [source,destination] of [[28,1],[1,28]]) {
    for (const authorized of [[],[source],[destination],[15],[26]]) for (const selected of [undefined,'',destination,String(destination)]) {
      assert.equal(access.assertDeliveryStockRequestDestinationAccess(selected,destination,authorized,{preview:true}),destination);
    }
  }
});

test('paired target access is limited to regular SO-based Delivery and excludes other routes', () => {
  assert.equal(access.canSalesAccessDeliveryRequest(request(28,1),[28]),true);
  assert.equal(access.canSalesAccessDeliveryRequest(request('1','28'),['1']),true);
  for (const record of [
    {...request(28,1),requestType:'special'},
    {...request(28,1),workflowVersion:1},
    ...['pickup','stocking','waitlist'].map(deliveryMethod=>({...request(28,1),regular:{...request(28,1).regular,deliveryMethod}})),
    {...request(28,1),regular:{...request(28,1).regular,deliveryVersion:2}},
    request(28,15),request(15,1),request(28,28),request(1,1)
  ]) assert.equal(access.canSalesAccessDeliveryRequest(record,[28]),false);
});

test('hostile target values and unrelated route grants cannot broaden shared paired access', () => {
  for (const value of [true,false,[],[28],{},null,'2.8e1',NaN,Infinity,0,13,2967,3445]) {
    assert.throws(()=>access.assertDeliveryStockRequestDestinationAccess(value,1,[28],{preview:true}),{status:403});
    assert.throws(()=>access.assertDeliveryStockRequestDestinationAccess(28,15,[value]),{status:403});
    assert.equal(access.canSalesAccessDeliveryRequest(request(value,1),[28]),false);
    assert.equal(access.canSalesAccessDeliveryRequest(request(28,15),[value]),false);
  }
  assert.equal(access.assertDeliveryStockRequestDestinationAccess(28,1,[]),1);
  assert.equal(access.canSalesAccessDeliveryRequest(request(28,1),[]),true);
});

test('property: every Sales account shares only supported paired routes on the current Delivery version', () => {
  fc.assert(fc.property(fc.subarray([1,28,15,26]),fc.constantFrom(1,28,15,26),fc.constantFrom(1,28,15,26),
    fc.constantFrom('regular','special'),fc.constantFrom(1,2),fc.constantFrom('pickup','delivery','stocking','waitlist'),
    fc.constantFrom(undefined,1,2),fc.boolean(),(authorized,source,destination,type,workflow,method,version,strings) => {
      const paired=(source===1&&destination===28)||(source===28&&destination===1);
      const record=request(strings?String(source):source,strings?String(destination):destination);
      record.requestType=type;record.workflowVersion=workflow;record.regular.deliveryMethod=method;record.regular.deliveryVersion=version;
      const expected=type==='regular'&&workflow===2&&method==='delivery'&&version===1&&paired;
      assert.equal(access.canSalesAccessDeliveryRequest(record,strings?authorized.map(String):authorized),expected);
    }),{seed:29673445,numRuns:1500});
});

test('property: both paired routes work for every Sales yard assignment while other versions remain restricted',()=>{
  fc.assert(fc.property(fc.constantFrom([28,1],[1,28]),fc.subarray([1,28,15,26]),fc.boolean(),([source,destination],authorized,strings)=>{
    const record=request(strings?String(source):source,strings?String(destination):destination);
    const grants=strings?authorized.map(String):authorized;
    assert.equal(access.assertDeliveryStockRequestDestinationAccess(record.regular.sourceLocationId,record.destinationLocationId,grants),destination);
    assert.equal(access.canSalesAccessDeliveryRequest(record,grants),true);
    record.regular.deliveryVersion=2;
    assert.equal(access.canSalesAccessDeliveryRequest(record,grants),false);
  }),{seed:9895,numRuns:200});
});
