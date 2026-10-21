import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import fc from 'fast-check';
import {stockingDisplayStatus} from '../../../src/regular-stock-reply-domain.js';
import {stockingActionLine,stockingLineState} from '../../../src/regular-stock-line-actions.js';

const request=()=>({id:1,requestRef:'REQ-LINES',requestType:'regular',workflowVersion:2,revision:1,requestedBy:'sales',status:'active',bucket:'pending',
  regular:{deliveryMethod:'stocking',stockingType:'purchase'},events:[],transfers:[],lines:[10,11].map(id=>({id,status:'submitted',itemName:'Material '+id,salesQty:20,salesUom:'EA',toPlt:100}))});
function ui(){
  const window={MBBS_I18N:{language:()=> 'en'}};
  const context=vm.createContext({window,Intl,Date,console});
  for(const file of ['regular-stock-ui.js','regular-stock-reply.js','regular-stock-resolution.js','regular-stock-purchase.js'])vm.runInContext(readFileSync(new URL('../../../public/'+file,import.meta.url),'utf8'),context);
  return window;
}
test('every Stocking Purchase material owns its four controls without bulk controls or selection',()=>{
  const window=ui(),r=request(),html=window.RegularPurchaseUI.detail(r,true);
  assert.doesNotMatch(html,/data-scm-stock-select-line|data-scm-stock-action="select-all"/);
  for(const line of r.lines)for(const action of ['purchase-add','reject','reply','resolve']){
    assert.match(html,new RegExp(`data-scm-stock-action="${action}"[^>]*data-line-id="${line.id}"`));
  }
  assert.equal((html.match(/data-scm-stock-action="reply"/g)||[]).length,2);
});
test('line reply editor and histories remain separate and escape customer text',()=>{
  const window=ui(),r=request();r.events=[{id:1,eventType:'regular_scm_reply',requestLineId:10,actorName:'SCM',createdAt:'2026-10-06',details:{message:'<script>A</script>'}},
    {id:2,eventType:'regular_scm_reply',requestLineId:11,actorName:'SCM',createdAt:'2026-10-06',details:{message:'Material B only'}}];
  const a=window.RegularStockReply.panel(r,'sales',{requestId:1,lineId:10,message:'Draft A'},false,'sales',{line:r.lines[0]});
  const b=window.RegularStockReply.panel(r,'sales',{requestId:1,lineId:10,message:'Draft A'},false,'sales',{line:r.lines[1]});
  assert.match(a,/&lt;script&gt;A&lt;\/script&gt;/);assert.doesNotMatch(a,/Material B only/);assert.match(a,/Draft A/);
  assert.match(b,/Material B only/);assert.doesNotMatch(b,/Draft A|data-regular-reply-form/);
});
test('an archived scoped instruction cannot authorize a reply on another material, while legacy instructions remain readable',()=>{
  const window=ui(),r=request();r.events=[{eventType:'regular_scm_reply',requestLineId:null,details:{lineId:10,message:'Only A'}}];
  assert.equal(window.RegularStockReply.eligible(r,'sales','sales',r.lines[0]),true);
  assert.equal(window.RegularStockReply.eligible(r,'sales','sales',r.lines[1]),false);
  r.events[0].details={message:'Historical request instruction'};
  assert.equal(window.RegularStockReply.eligible(r,'sales','sales',r.lines[1]),true);
  assert.match(window.RegularStockReply.panel(r,'sales',null,false,'sales'),/Historical request instruction/);
});
test('Resolve eligibility uses the target line while committed and closed materials stay locked',()=>{
  const window=ui(),r=request();r.lines[0].status='approved';r.lines[0].purchase={demandId:1};
  assert.equal(window.RegularStockResolution.eligible(r,r.lines[0]),false);assert.equal(window.RegularStockResolution.eligible(r,r.lines[1]),true);
  r.lines[1].status='closed';r.lines[1].resolution={purchaseOrderRef:'PO-A',eta:'2026-10-15'};
  assert.equal(window.RegularStockResolution.eligible(r,r.lines[1]),false);assert.match(window.RegularStockResolution.result(r,r.lines[1]),/PO-A/);
});
test('property: line waiting statuses ignore terminal materials and retain remaining open conversations',()=>{
  fc.assert(fc.property(fc.array(fc.record({status:fc.constantFrom('submitted','approved','closed','rejected'),replyStatus:fc.constantFrom(null,'pending_update','pending_scm')}),{minLength:1,maxLength:30}),lines=>{
    const r=request();r.lines=lines;r.regular.stockingType='transfer';
    const active=lines.filter(line=>['submitted','approved'].includes(line.status));
    const expected=active.some(line=>line.replyStatus==='pending_scm')?'pending_scm':active.some(line=>line.replyStatus==='pending_update')?'pending_update':'pending';
    assert.equal(stockingDisplayStatus(r),expected);
  }),{seed:202610061,numRuns:200});
});
test('property: selecting a line returns exactly that material and rejects ambiguity or hostile identifiers',()=>{
  fc.assert(fc.property(fc.uniqueArray(fc.integer({min:1,max:1000000}),{minLength:2,maxLength:12}),ids=>{
    const r={lines:ids.map(id=>({id}))};for(const id of ids){assert.equal(stockingActionLine(r,id,'INVALID').id,id);assert.equal(stockingActionLine(r,String(id),'INVALID').id,id);}
    for(const bad of [undefined,null,true,[],[ids[0]],{},0,-1,1.5,'1e0',' '+ids[0]])assert.throws(()=>stockingActionLine(r,bad,'INVALID'),error=>error.status===400);
  }),{seed:202610062,numRuns:200});
});
test('property: updating one line merges its metadata and preserves every other line and the input object',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000000}),fc.string(),fc.string(),(id,message,eta)=>{
    const states={[id]:{reply:{message},resolution:{eta}},[id+1]:{replyStatus:'pending_scm'}};
    const r={regular:{stockingLines:states}},before=JSON.stringify(r),result=stockingLineState(r,id,{replyStatus:null});
    assert.deepEqual(result[id],{...states[id],replyStatus:null});assert.deepEqual(result[id+1],states[id+1]);assert.equal(JSON.stringify(r),before);
  }),{seed:202610063,numRuns:200});
});
