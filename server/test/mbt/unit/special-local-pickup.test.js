import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {isLocalPickupChange} from '../../../src/special-stock-fulfillment-policy.js';

test('property: only pickup-to-pickup changes with no saved remote plan are local',()=>{
  const methods=fc.oneof(fc.constantFrom('vendor_pickup','yard_pickup','mbt_delivery',null,undefined),fc.string());
  fc.assert(fc.property(methods,methods,fc.boolean(),(before,after,hasPlan)=>{
    const expected=!hasPlan && (before==='vendor_pickup'||before==='yard_pickup') && (after==='vendor_pickup'||after==='yard_pickup');
    assert.equal(isLocalPickupChange(before,after,hasPlan?{version:1}:null),expected);
  }),{numRuns:250,seed:20260928});
  for(const from of ['yard_pickup','vendor_pickup']) for(const to of ['yard_pickup','vendor_pickup']) {
    assert.equal(isLocalPickupChange(from,to),true);
    assert.equal(isLocalPickupChange(from,to,{target:{methodId:1}}),false);
  }
});
