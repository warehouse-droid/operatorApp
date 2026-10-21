import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {assertDeliveryStockRequestDestinationAccess,can150SalesAccessDeliveryRequest} from '../../../src/regular-stock-delivery-access.js';

const yards = [1,28,15,26];
const request = (source,destination) => ({requestType:'regular',workflowVersion:2,destinationLocationId:destination,
  regular:{deliveryMethod:'delivery',deliveryVersion:1,sourceLocationId:source}});

test('150 Sales can authorize both delivery directions with numeric and string yard IDs', () => {
  for (const [source,destination] of [[1,28],[28,1]]) {
    assert.equal(assertDeliveryStockRequestDestinationAccess(source,destination,[26]),destination);
    assert.equal(assertDeliveryStockRequestDestinationAccess(String(source),String(destination),['26']),destination);
  }
});
test('150 Sales can discover a paired Base Yard before selecting or replacing the supplying yard', () => {
  for (const destination of [1,28]) {
    for (const source of [undefined,'',destination,String(destination)]) {
      assert.equal(assertDeliveryStockRequestDestinationAccess(source,destination,[26],{preview:true}),destination);
    }
  }
});
test('property: delivery authorization supports assigned destinations and both paired routes for every Sales account', () => {
  fc.assert(fc.property(fc.subarray(yards),fc.constantFrom(...yards),fc.constantFrom(...yards),fc.boolean(),
    (authorized,source,destination,strings) => {
      const expected = authorized.includes(destination) || ((source===1 && destination===28) || (source===28 && destination===1));
      const input = strings ? [String(source),String(destination),authorized.map(String)] : [source,destination,authorized];
      if (expected) {
        assert.equal(assertDeliveryStockRequestDestinationAccess(...input),destination);
      } else {
        assert.throws(() => assertDeliveryStockRequestDestinationAccess(...input),{status:403,code:'STOCK_REQUEST_YARD_FORBIDDEN'});
      }
    }),{seed:1503445,numRuns:600});
});
test('property: shared request access is limited to current regular SO-based delivery records', () => {
  fc.assert(fc.property(fc.subarray(yards),fc.constantFrom(...yards),fc.constantFrom(...yards),
    fc.constantFrom('regular','special'),fc.constantFrom(1,2),fc.constantFrom('pickup','delivery','stocking','waitlist'),
    fc.constantFrom(undefined,1,2),(authorized,source,destination,type,workflow,method,version) => {
      const record = request(source,destination);
      record.requestType=type;record.workflowVersion=workflow;record.regular.deliveryMethod=method;record.regular.deliveryVersion=version;
      assert.equal(can150SalesAccessDeliveryRequest(record,authorized),authorized.includes(26)
        && type==='regular' && workflow===2 && method==='delivery' && version===1
        && ((source===1 && destination===28) || (source===28 && destination===1)));
    }),{seed:1502967,numRuns:1000});
});
test('property: every other request method is denied on an otherwise valid paired Delivery route', () => {
  fc.assert(fc.property(fc.constantFrom('pickup','stocking','waitlist'),fc.boolean(),fc.boolean(),(method,reverse,strings) => {
    const [source,destination]=reverse?[28,1]:[1,28];
    const record=request(strings?String(source):source,strings?String(destination):destination);
    assert.equal(can150SalesAccessDeliveryRequest(record,[26]),true);
    record.regular.deliveryMethod=method;
    assert.equal(can150SalesAccessDeliveryRequest(record,[26]),false);
  }),{seed:1502026,numRuns:300});
});
test('hostile yard inputs cannot activate the 150 delivery exception', () => {
  for (const source of [true,false,[],[1],{},null,'1e0',NaN,Infinity,0,13,3445,2967]) {
    assert.equal(can150SalesAccessDeliveryRequest(request(source,28),[26]),false);
    assert.throws(() => assertDeliveryStockRequestDestinationAccess(source,28,[26],{preview:true}),{status:403});
  }
  assert.equal(can150SalesAccessDeliveryRequest(request(1,28),[]),false);
  assert.equal(can150SalesAccessDeliveryRequest({...request(1,28),regular:{}},[26]),false);
});
