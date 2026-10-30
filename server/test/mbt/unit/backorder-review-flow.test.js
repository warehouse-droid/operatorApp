import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {createBackorderUI} from '../../../public/backorder-stock-requests.js';
import {canAttachBackorderSalesOrder} from '../../../public/backorder-review-policy.js';

globalThis.window ??= {};
function request(lines, extra = {}) {
  return {id:1,revision:1,requestRef:'STREQ-REVIEW',workflowKind:'backorder',requestType:'regular',
    workflowVersion:2,stage:'await_customer_confirmation',status:'active',closeStatus:'active',
    fulfillmentMethod:'yard_pickup',destinationLocationId:1,destinationName:'3445',regular:{},
    lines:lines.map((line,index)=>({id:index+1,originalRate:null,vendorName:'Vendor',
      vendorId:331,salesDecision:'pending',...line})),transfers:[],events:[],...extra};
}
function render(d, audience = 'sales') {
  return createBackorderUI({mount:{addEventListener(){}},audience,api:async()=>({vendors:[]}),
    getDetail:()=>d,setDetail(){},render(){}}).detail(d);
}
const reviewed = status => ({supplyStatus:status,stockCheckedAt:'2026-10-22T20:00:00Z',respondedAt:'2026-10-22T20:00:00Z',responseRevision:1});

test('all SCM replies expose the optional SO before Sales acceptance',()=>{
  const d=request([reviewed('allocation'),reviewed('in_stock')]);
  assert.match(render(d),/data-action="already-ordered\/sales-order"/);
  assert.doesNotMatch(render(d),/name="quotationNumber"/);
  assert.doesNotMatch(render(d,'scm'),/data-action="already-ordered\/sales-order"/);
  assert.match(render(d),/data-action="sales-order\/link"/);
});

test('generated attachment eligibility follows saved SCM replies, preserving Already Ordered compatibility',()=>{
  const material=fc.record({supplyStatus:fc.constantFrom(null,'in_stock','low_inventory','vendor_transfer','production','allocation','no_stock','already_ordered'),
    replied:fc.boolean(),decision:fc.constantFrom('pending','accepted','request_update','declined','closed')});
  fc.assert(fc.property(fc.array(material,{maxLength:8}),rows=>{
    const lines=rows.map(row=>({supplyStatus:row.supplyStatus,salesDecision:row.decision,
      stockCheckedAt:row.replied?'2026-10-22T20:00:00Z':null}));
    const expected=rows.some(row=>row.supplyStatus==='already_ordered')
      || rows.length>0 && rows.every(row=>row.supplyStatus && row.replied);
    assert.equal(render(request(lines)).includes('data-action="already-ordered/sales-order"'),expected);
    assert.equal(render(request(lines),'scm').includes('data-action="already-ordered/sales-order"'),false);
  }),{seed:165186,numRuns:400});
});

test('saved Sales and SCM replies render independent accessible edit controls',()=>{
  const d=request([{...reviewed('production'),salesDecision:'accepted',salesDecisionReason:'Saved reason'},reviewed('allocation')]);
  const sales=render(d),scm=render(d,'scm');
  assert.match(sales,/Edit Sales confirmation/);
  assert.match(sales,/aria-expanded="false"[^>]*aria-controls="[^"]+"/);
  assert.equal((sales.match(/data-backorder-edit=/g)||[]).length,1);
  assert.equal((scm.match(/Edit material review/g)||[]).length,2);
  assert.match(scm,/data-backorder-editor[^>]*hidden/);
});

test('generated saved review editors distinguish pending replies from saved values',()=>{
  fc.assert(fc.property(fc.constantFrom('pending','accepted','request_update','declined','closed'),
    fc.constantFrom(null,'stockCheckedAt','respondedAt','responseRevision'),(decision,reply)=>{
      const line={supplyStatus:'production',salesDecision:decision,...(reply?{[reply]:reply==='responseRevision'?2:'2026-10-22T20:00:00Z'}:{})};
      assert.equal(render(request([line])).includes('Edit Sales confirmation'),decision!=='pending');
      assert.equal(render(request([line]),'scm').includes('Edit material review'),Boolean(reply));
    }),{seed:186165,numRuns:100});
});

test('generated terminal eligibility preserves legacy Already Ordered references without reopening closed requests',()=>{
  fc.assert(fc.property(fc.constantFrom('await_customer_confirmation','completed','closed'),
    fc.constantFrom('active','cancelled'),fc.constantFrom('active','closure_pending','closed'),
    fc.boolean(),fc.boolean(),(stage,status,closeStatus,operationallyComplete,ordered)=>{
      const d=request([reviewed(ordered?'already_ordered':'in_stock')],{stage,status,closeStatus,operationallyComplete});
      const allowed=stage!=='closed' && status!=='cancelled' && closeStatus==='active'
        && (ordered || (stage!=='completed' && !operationallyComplete));
      assert.equal(canAttachBackorderSalesOrder(d),allowed);
    }),{seed:165186,numRuns:300});
  assert.equal(canAttachBackorderSalesOrder({}),false);
});
