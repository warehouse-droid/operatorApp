import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {canLinkBackorderOrder,assertBackorderOrderLink} from '../../../public/backorder-workflow.js';
import {createBackorderUI} from '../../../public/backorder-stock-requests.js';

globalThis.window ??= {};
function detail(overrides={}) {
  return {id:224,revision:10,requestRef:'STREQ-000133',workflowKind:'backorder',requestType:'regular',workflowVersion:2,
    stage:'confirmed',status:'active',closeStatus:'active',fulfillmentMethod:'yard_pickup',destinationLocationId:1,
    destinationName:'TEST yard',regular:{deliveryMethod:'backorder'},transfers:[],events:[],salesOrderId:1063016,
    salesOrderRef:'TEST-SO',purchaseOrderId:null,
    lines:[{id:209,salesDecision:'pending',supplyStatus:'in_stock',stockCheckedAt:'2026-10-19T17:43:58.527Z',originalRate:null}],...overrides};
}
function html(d) {
  return createBackorderUI({mount:{addEventListener(){}},audience:'scm',api:async()=>({vendors:[]}),getDetail:()=>d,setDetail(){},render(){}}).detail(d);
}

test('PO recheck restores SCM PO controls after an SO link without changing Sales decisions',()=>{
  const d=detail(),before=structuredClone(d);
  assert.equal(canLinkBackorderOrder(d,'purchase_order'),true);
  assert.doesNotThrow(()=>assertBackorderOrderLink(d,'purchase_order'));
  const markup=html(d);
  assert.match(markup,/data-action="purchase-order\/link"/);
  assert.match(markup,/name="purchaseOrderRef"/);
  assert.match(markup,/<button[^>]*type="submit">Manual PO link<\/button>/);
  assert.deepEqual(d,before);
});

test('PO recheck requires a linked SO and current stock review for pending materials',()=>{
  const line=fc.record({salesDecision:fc.constantFrom('pending','accepted','request_update','declined','closed'),
    supplyStatus:fc.constantFrom(null,'in_stock','low_inventory','vendor_transfer','production','allocation','no_stock','already_ordered'),
    stockCheckedAt:fc.constantFrom(null,'2099-01-01T12:00:00Z')});
  fc.assert(fc.property(fc.array(line,{minLength:0,maxLength:12}),fc.boolean(),fc.constantFrom('sales_order','purchase_order','invalid'),(lines,so,kind)=>{
    const d=detail({salesOrderId:so?123:null,lines:lines.map((row,index)=>({...row,id:index+1,originalRate:null}))});
    const open=lines.filter(row=>row.supplyStatus!=='already_ordered'&&!['declined','closed'].includes(row.salesDecision));
    const expected=['sales_order','purchase_order'].includes(kind)&&open.length>0&&open.every(row=>Boolean(row.supplyStatus&&row.stockCheckedAt)
      &&(row.salesDecision==='accepted'||kind==='purchase_order'&&so&&row.salesDecision==='pending'));
    assert.equal(canLinkBackorderOrder(d,kind),expected);
    if(expected)assert.doesNotThrow(()=>assertBackorderOrderLink(d,kind));
    else assert.throws(()=>assertBackorderOrderLink(d,kind),{code:'BACKORDER_SALES_ACCEPTANCE_REQUIRED',status:409});
  }),{seed:20261019,numRuns:1200});
  const d=detail();
  for(const override of [{salesDecision:'request_update'},{stockCheckedAt:null},{supplyStatus:null}]) {
    assert.equal(canLinkBackorderOrder({...d,lines:[{...d.lines[0],...override}]},'purchase_order'),false);
  }
  assert.equal(canLinkBackorderOrder({...d,salesOrderId:null},'purchase_order'),false);
  assert.equal(canLinkBackorderOrder(d,'sales_order'),false);
  assert.equal(canLinkBackorderOrder(d,'invalid'),false);
  assert.equal(canLinkBackorderOrder({...d,lines:[]},'purchase_order'),false);
  for(const supplyStatus of ['in_stock','low_inventory','vendor_transfer','production','allocation','no_stock']) {
    assert.equal(canLinkBackorderOrder({...d,lines:[{...d.lines[0],supplyStatus}]},'purchase_order'),true);
  }
});

test('PO recheck keeps closed cases and existing PO links out of the form',()=>{
  for(const override of [{stage:'closed'},{stage:'completed'},{purchaseOrderId:456,purchaseOrderRef:'TEST-PO'}]) {
    assert.doesNotMatch(html(detail(override)),/data-action="purchase-order\/link"/);
  }
  for(const resolved of [{salesDecision:'closed'},{salesDecision:'declined'},{supplyStatus:'already_ordered'}]) {
    const d=detail();d.lines=[{...d.lines[0],...resolved}];
    assert.equal(canLinkBackorderOrder(d,'purchase_order'),false);
    assert.doesNotMatch(html(d),/data-action="purchase-order\/link"/);
  }
});
