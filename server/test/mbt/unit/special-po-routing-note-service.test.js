import assert from 'node:assert/strict';
import test from 'node:test';
import {createSpecialPurchaseOrderRoutingService} from '../../../src/special-stock-purchase-order-routing.js';

function fixture(overrides={}) {
  const events=[],detail={id:83,revision:7,purchaseOrderId:1030348,purchaseOrderRef:'POB03976',vendorId:331,stage:'confirmed',closeStatus:'active'};
  const service=createSpecialPurchaseOrderRoutingService({transaction:async run=>run(),lockCase:async()=>{},
    getCase:async()=>detail,getOrder:async()=>({id:'PACK-17',originalPoRef:'POB03976'}),
    readNote:async()=>{events.push(['read']);return 'for SOB121819';},
    updateNote:async input=>{events.push(['remote',input]);return input.note;},
    cacheNote:async(_detail,note)=>events.push(['cache',note]),audit:async()=>events.push(['audit']),
    updateSchedule:async input=>{events.push(['schedule',input]);return{updated:true};},...overrides});
  return {service,events,detail};
}
const input={expectedRevision:7,expectedUpdatedAt:'2099-01-01T00:00:00.000000Z',expectedNote:'for SOB121819',
  notes:'Updated PO Note',remarkOverride:'Local Remark',method:'MBT',orderKind:'PO'};

test('Special Request routing sends Note only to NetSuite and Remark only to the local schedule',async()=>{
  const f=fixture();
  await f.service.save(83,input,{operatorId:'test'});
  const schedule=f.events.find(([kind])=>kind==='schedule')[1];
  assert.equal(schedule.orderRef,'PACK-17');assert.equal(schedule.orderKind,'PO');
  assert.equal(schedule.patch.remarkOverride,'Local Remark');
  assert.equal(Object.hasOwn(schedule.patch,'notes'),false);
  assert.equal(schedule.expectedUpdatedAt,input.expectedUpdatedAt);
  assert.deepEqual(f.events.find(([kind])=>kind==='remote')[1],{purchaseOrderId:1030348,purchaseOrderRef:'POB03976',
    vendorId:331,note:'Updated PO Note',expectedNote:'for SOB121819'});
  assert.deepEqual(f.events.map(([kind])=>kind),['schedule','remote','cache','audit']);
});

test('reading the Special Request Note uses the linked real PO and caches only that source Note',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.readNote(83),{note:'for SOB121819'});
  assert.deepEqual(f.events,[['read'],['cache','for SOB121819']]);
});

test('stale requests, test skips, closed requests and synthetic split targets cannot write a PO Note',async()=>{
  for(const patch of [{revision:8},{purchaseOrderId:null},{purchaseOrderSkipped:true},{stage:'closed'},
    {closeStatus:'closure_pending'},{quantityReviewPending:true}]) {
    const f=fixture();Object.assign(f.detail,patch);
    await assert.rejects(()=>f.service.save(83,input,{operatorId:'test'}));
    assert.deepEqual(f.events,[]);
  }
  const split=fixture({getOrder:async()=>({id:'SPLIT-17',originalPoRef:'OTHER-PO',isScmSplit:true})});
  await assert.rejects(()=>split.service.save(83,input,{operatorId:'test'}),{status:409});
  assert.deepEqual(split.events,[]);
});

test('a stale local schedule fails before calling NetSuite',async()=>{
  const f=fixture({updateSchedule:async()=>{throw Object.assign(Error('Stale schedule'),{status:409});}});
  await assert.rejects(()=>f.service.save(83,input,{operatorId:'test'}),{status:409});
  assert.deepEqual(f.events,[]);
});
