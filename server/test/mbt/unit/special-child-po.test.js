import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {specialOrderSnapshot} from '../../../src/special-stock-documents.js';
import {specialPoRoutingHtml} from '../../../public/special-stock-po-routing.js';
import {createSpecialPurchaseOrderRoutingService} from '../../../src/special-stock-purchase-order-routing.js';
import {specialDispatchPlanning} from '../../../src/special-stock-planning.js';

test('manually linked PO preview uses its native identity without local draft lines',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:2_000_000_000}),id=>{
    const detail={purchaseOrderId:id,purchaseOrderRef:'POB03429',purchaseOrderCustomLinkage:true,purchaseOrderLines:[]};
    assert.equal(specialOrderSnapshot(detail,'purchase_order','scm').id,id);
    assert.throws(()=>specialOrderSnapshot(detail,'purchase_order','sales'),{status:403});
    assert.throws(()=>specialOrderSnapshot({...detail,purchaseOrderId:null},'purchase_order','scm'),{status:409});
    assert.throws(()=>specialOrderSnapshot({...detail,purchaseOrderSkipped:true},'purchase_order','scm'),{status:409});
  }),{seed:3429,numRuns:40});
});

test('routing selector lists exact child identities and keeps local child notes clear',()=>{
  const detail={id:1,revision:3,purchaseOrderId:10,purchaseOrderRef:'POB03429',purchaseOrderSplitId:7,purchaseOrderTargetRef:'PO#B03429 (L4)',stage:'confirmed'};
  const order={id:'PO#B03429 (L4)',sourcePoRef:'POB03429',isScmSplit:true,scm:{notes:'Child note'}};
  const html=specialPoRoutingHtml(detail,{ref:'POB03429',order,splits:[{id:7,ref:order.id},{id:8,ref:'Other <child>'}]});
  assert.match(html,/data-special-po-split-form/);
  assert.match(html,/value="7" selected/);
  assert.match(html,/Other &lt;child&gt;/);
  assert.match(html,/Saved to this child PO/);
  assert.doesNotMatch(html,/Saved to the NetSuite PO/);
  assert.match(html,/name="packingSlipRef" readonly/);
});

test('child routing changes only its schedule and never sends a shared NetSuite Note',async()=>{
  const calls=[];
  const detail={id:1,revision:3,purchaseOrderId:10,purchaseOrderRef:'POB03429',purchaseOrderSplitId:7,purchaseOrderTargetRef:'CHILD',stage:'confirmed'};
  const service=createSpecialPurchaseOrderRoutingService({transaction:async run=>run(),lockCase:async()=>{},
    getCase:async()=>detail,getOrder:async ref=>{assert.equal(ref,'CHILD');return{id:'CHILD',sourcePoRef:'POB03429',isScmSplit:true,scmSplitId:7,scmSplitRevision:2};},
    updateSchedule:async input=>{calls.push(input);return{updated:true};},
    updateNote:async()=>{throw Error('Must not write shared parent Note');},cacheNote:async()=>{throw Error('Must not change parent cache');},audit:async()=>{}});
  await service.save(1,{expectedRevision:3,expectedUpdatedAt:null,expectedSplitRevision:2,notes:'Child note',method:'Vendor'});
  assert.equal(calls.length,1);assert.equal(calls[0].orderRef,'CHILD');
  assert.equal(calls[0].patch.notes,'Child note');assert.equal(calls[0].expectedSplitRevision,2);
  await assert.rejects(()=>service.save(1,{expectedRevision:3,expectedSplitRevision:2,packingSlipRef:'OTHER'}),{status:409});
  assert.equal(calls.length,1);
});

test('property: sibling or source planning never counts as selected-child planning',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:10000}),id=>{
    const selected=`CHILD-${id}`,sibling=`CHILD-${id+1}`;
    const detail={purchaseOrderId:10,purchaseOrderRef:'SOURCE',purchaseOrderTargetRef:selected,purchaseOrderReference:selected};
    const plan=refs=>[{status:'draft',plannedOrderReferences:new Map(refs.map(ref=>[ref,{planId:'1'}]))}];
    assert.equal(specialDispatchPlanning(detail,plan(['SOURCE',sibling])).purchaseOrder.planned,false);
    assert.equal(specialDispatchPlanning(detail,plan([selected])).purchaseOrder.planned,true);
  }),{seed:3429,numRuns:50});
});
