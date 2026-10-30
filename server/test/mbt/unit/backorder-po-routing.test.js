import assert from 'node:assert/strict';
import test from 'node:test';
import {createSpecialPurchaseOrderRoutingService} from '../../../src/special-stock-purchase-order-routing.js';

test('whole Backorder PO note uses the linked PO vendor instead of a per-material request vendor',async()=>{
  const calls=[],detail={id:1,workflowKind:'backorder',revision:2,purchaseOrderId:100,purchaseOrderRef:'POB04147',vendorId:null,stage:'confirmed'};
  const service=createSpecialPurchaseOrderRoutingService({transaction:async run=>run(),lockCase:async()=>{},getCase:async()=>detail,
    getOrder:async()=>({id:'POB04147'}),getVendor:async identity=>{assert.equal(identity.purchaseOrderId,100);return 331;},
    readNote:async identity=>{assert.equal(identity.vendorId,331);return 'Whole PO note';},
    updateNote:async identity=>{assert.equal(identity.vendorId,331);calls.push(identity);return identity.note;},
    cacheNote:async()=>{},audit:async()=>{},updateSchedule:async()=>({updated:true})});
  assert.deepEqual(await service.readNote(1),{note:'Whole PO note'});
  await service.save(1,{expectedRevision:2,notes:'Updated whole PO note',expectedNote:'Whole PO note'});
  assert.equal(calls.length,1);assert.equal(calls[0].purchaseOrderRef,'POB04147');
});
