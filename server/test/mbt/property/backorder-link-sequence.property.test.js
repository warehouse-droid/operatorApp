import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {backorderStage,canLinkBackorderOrder,assertBackorderOrderLink} from '../../../public/backorder-workflow.js';
import {createBackorderUI} from '../../../public/backorder-stock-requests.js';

globalThis.window ??= {};
function detail(overrides={}) {
  return {id:1,revision:1,requestRef:'STREQ-TEST',workflowKind:'backorder',requestType:'regular',workflowVersion:2,stage:'new_enquiry',status:'submitted',fulfillmentMethod:'yard_pickup',destinationLocationId:1,destinationName:'3445',regular:{deliveryMethod:'backorder'},lines:[],transfers:[],events:[],...overrides};
}
function html(role,d) {
  const ui=createBackorderUI({mount:{addEventListener(){}},audience:role,api:async()=>({vendors:[]}),getDetail:()=>d,setDetail(){},render(){}});
  return ui.detail(d);
}
const line=fc.record({salesDecision:fc.constantFrom('pending','accepted','request_update','declined','closed'),supplyStatus:fc.constantFrom(null,'in_stock','low_inventory','vendor_transfer','production','allocation','no_stock','already_ordered'),stockCheckedAt:fc.constantFrom(null,'2099-01-01T12:00:00Z')});
const lines=fc.array(line,{minLength:0,maxLength:15}).map(rows=>rows.map((row,index)=>({...row,id:index+1,originalRate:null,vendorName:'TEST vendor',vendorId:331})));

test('Both order forms become available at Confirmed independently of the other order or its planning',()=>{
  fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.boolean(),fc.string(),(po,planned,so,ref)=>{
    const d=detail({stage:'confirmed',lines:[{id:1,originalRate:null,salesDecision:'accepted',supplyStatus:'in_stock',stockCheckedAt:'2099-01-01'}],purchaseOrderId:po?456:null,salesOrderId:so?123:null,purchaseOrderRef:ref,dispatchPlanning:{purchaseOrder:{planned}}});
    assert.equal(html('sales',d).includes('data-action="sales-order/link"'),!so);
    assert.equal(html('scm',d).includes('data-action="purchase-order/link"'),!po);
    for(const kind of ['sales_order','purchase_order'])assert.doesNotThrow(()=>assertBackorderOrderLink(d,kind));
    assert.ok(!html('sales',d).includes('after SCM links the PO'));
  }),{seed:20261007,numRuns:700});
});
test('Both link guards require reviewed and accepted open materials, including mixed Already Ordered lines',()=>{
  fc.assert(fc.property(lines,fc.boolean(),(materials,linked)=>{
    const d=detail({lines:materials});
    const open=materials.filter(material=>material.supplyStatus!=='already_ordered'&&!['declined','closed'].includes(material.salesDecision));
    const accepted=open.length>0&&open.every(material=>Boolean(material.supplyStatus)&&Boolean(material.stockCheckedAt)&&material.salesDecision==='accepted');
    for(const [role,kind,id] of [['sales','sales_order','salesOrderId'],['scm','purchase_order','purchaseOrderId']]){
      assert.equal(canLinkBackorderOrder(d,kind),accepted);
      if(accepted)assert.doesNotThrow(()=>assertBackorderOrderLink(d,kind));
      else assert.throws(()=>assertBackorderOrderLink(d,kind),{code:'BACKORDER_SALES_ACCEPTANCE_REQUIRED',status:409});
      assert.equal(html(role,{...d,[id]:linked?123:null}).includes(`data-action="${kind.replace('_','-')}/link"`),!linked&&accepted);
    }
  }),{seed:38,numRuns:700});
});
test('SO and PO readiness rejects each missing prerequisite and accepts resolved companion materials',()=>{
  const accepted={id:1,salesDecision:'accepted',supplyStatus:'in_stock',stockCheckedAt:'2099-01-01',originalRate:null};
  for(const kind of ['sales_order','purchase_order']){
    for(const change of [{salesDecision:'pending'},{salesDecision:'request_update'},{stockCheckedAt:null},{supplyStatus:null}]){
      assert.equal(canLinkBackorderOrder(detail({lines:[{...accepted,...change}]}),kind),false);
    }
    for(const resolved of [{salesDecision:'declined'},{salesDecision:'closed'},{salesDecision:'pending',supplyStatus:'already_ordered'}]){
      assert.equal(canLinkBackorderOrder(detail({lines:[accepted,{...accepted,...resolved,id:2}]}),kind),true);
      assert.equal(canLinkBackorderOrder(detail({lines:[{...accepted,...resolved}]}),kind),false);
    }
    assert.doesNotThrow(()=>assertBackorderOrderLink({workflowKind:'special'},kind));
  }
  assert.equal(canLinkBackorderOrder(detail({lines:[accepted]}),'invalid'),false);
  assert.match(html('sales',detail()),/SCM must review stock and Sales must accept every open material before linking an SO/);
  assert.doesNotMatch(html('sales',detail()),/after SCM links the PO/);
});
test('Terminal Backorders keep order links blocked and only Completed Already Ordered requests offer SO references',()=>{
  fc.assert(fc.property(lines,fc.constantFrom('closed','completed'),fc.boolean(),(materials,stage,planned)=>{
    const d=detail({lines:materials,stage,purchaseOrderId:456,dispatchPlanning:{purchaseOrder:{planned}}});
    assert.equal(html('sales',d).includes('data-action="sales-order/link"'),false);assert.equal(html('scm',d).includes('data-action="purchase-order/link"'),false);
    const ordered=materials.some(material=>material.supplyStatus==='already_ordered');
    assert.equal(html('sales',d).includes('data-action="quotation/link"'),!ordered);assert.equal(html('scm',d).includes('data-action="quotation/link"'),false);
    assert.equal(html('sales',d).includes('data-action="already-ordered/sales-order"'),ordered&&stage==='completed');assert.equal(html('scm',d).includes('data-action="already-ordered/sales-order"'),false);
  }),{seed:82,numRuns:150});
});

test('Backorder stages require a queued PO reference and actual completion for every fulfillment method',()=>{
  fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),fc.constantFrom('yard_pickup','mbt_delivery','vendor_pickup'),(replied,accepted,po,so,pending,reference,queued,complete,method)=>{
    const evidence={linesResolved:replied,hasAcceptedLines:accepted,purchaseOrderId:po?456:null,salesOrderId:so?123:null,pendingUpdate:pending,fulfillmentMethod:method,hasPendingSalesDecision:true,waitingForProduction:true,purchaseOrderReference:reference?'TEST-REF':'',purchaseOrderDispatchStatus:queued?'Queued':'Hold',operationallyComplete:complete};
    const expected=replied&&!accepted?'closed':complete?'completed':pending?'pending_update':po?(reference&&queued?'dispatch_arrangement':'confirmed'):so||replied?'confirmed':'await_customer_confirmation';
    assert.equal(backorderStage(evidence),expected);
  }),{seed:20261008,numRuns:700});
});
