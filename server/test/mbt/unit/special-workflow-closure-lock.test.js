/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {prepareSpecialClosurePlan,applySpecialClosurePlan} from '../../../src/special-stock-closure-adapter.js';
import * as queue from '../../../public/special-stock-case-status.js';

const lock=()=>Object.assign(Error('This record has been locked by a user defined workflow.'),{status:400,netsuiteErrorCodes:['USER_ERROR']});
const expected=()=>[{id:101,kind:'sales_order',discountCount:1,lines:[
 {remoteLineId:1010,itemId:2055,quantity:50,unitId:865,description:'Reviewed'},
 {remoteLineId:1012,itemId:1784,quantity:11,unitId:246,description:'PALLET'}]},
 {id:102,kind:'purchase_order',lines:[{remoteLineId:1020,itemId:2055,quantity:50,unitId:865,description:'Reviewed'}]}];
export function fixture({salesClosed=true,conversion=1}={}) {
 const remote=new Map([[101,[{line:1,key:1010,itemId:2055,quantity:50,unitId:865,rate:20,description:'Reviewed',closed:salesClosed},
  {line:2,key:1011,itemId:10716,quantity:null,unitId:null,rate:-150,description:'',closed:salesClosed},
  {line:3,key:1012,itemId:1784,quantity:11,unitId:246,rate:40,description:'PALLET',closed:salesClosed}]],
 [102,[{line:1,key:1020,itemId:2055,quantity:50,unitId:865,rate:5,description:'Reviewed',closed:false}]]]);
 const writes=[],gets=[],reads=[];let mutateRows=rows=>rows,openError=null,closedError=null,loseResponse=false;
 return {remote,writes,gets,reads,set mutateRows(fn){mutateRows=fn;},set openError(error){openError=error;},
  set closedError(error){closedError=error;},set loseResponse(value){loseResponse=value;},
  queryAll:async sql=>{
   const id=Number(/tl.transaction = (\d+)/.exec(sql)[1]);reads.push(id);
   return mutateRows(remote.get(id).map(line=>({uniquekey:String(line.key),rest_line_id:String(line.line),item:String(line.itemId),
    execution_quantity:'0',billed_quantity:'0',line_closed:line.closed?'T':'F',
    status_text:remote.get(id).every(l=>l.closed)?'Closed':id===101?'Pending Fulfillment':'Pending Receipt',
    ...(line.quantity===null?{}:{base_quantity:String(line.quantity*conversion*(id===101?-1:1)),unit_id:String(line.unitId)}),
    line_rate:String(line.rate),description:line.description})),id);
  },
  rest:async(path,options={})=>{
   const id=Number(/\/(\d+)/.exec(path)[1]),lines=remote.get(id);
   if(options.method==='PATCH'){
    assert.ok(lines.some(l=>!l.closed),'Do not write a closed record');
    writes.push({id,body:structuredClone(options.body)});
    for(const patch of options.body.item.items){assert.deepEqual(Object.keys(patch).sort(),['isClosed','line']);lines.find(l=>l.line===patch.line).closed=patch.isClosed;}
    // Discount closes with its material; it never receives an isClosed write.
    if(lines.filter(l=>l.itemId!==10716).every(l=>l.closed))for(const l of lines)l.closed=true;
    if(loseResponse){loseResponse=false;throw Error('Lost close response');}
    return {data:{}};
   }
   gets.push(id);
   if(lines.every(l=>l.closed))throw closedError||lock();
   if(openError)throw openError;
   return {data:{item:{items:lines.map(l=>({line:l.line,item:{id:String(l.itemId)},quantity:l.quantity,
    units:l.unitId===null?undefined:String(l.unitId),rate:l.rate,description:l.description,isClosed:l.closed}))}}};
  }};
}

test('workflow-locked closed SO verifies and only the pending PO is closed through REST',async()=>{
 const b=fixture(),plan=await prepareSpecialClosurePlan({orders:expected()},b);
 assert.equal(b.writes.length,0);
 assert.deepEqual((await applySpecialClosurePlan(plan,b)).verifiedOrderIds,[102,101]);
 assert.deepEqual(b.writes,[{id:102,body:{item:{items:[{line:1,isClosed:true}]}}}]);
 await applySpecialClosurePlan(JSON.parse(JSON.stringify(plan)),b);assert.equal(b.writes.length,1);
 assert.deepEqual(b.remote.get(101).map(l=>[l.key,l.rate,l.quantity]),[[1010,20,50],[1011,-150,null],[1012,40,11]]);
});

test('property: only Custom Discount% may retain an unset line flag on an otherwise closed order', async () => {
 await fc.assert(fc.asyncProperty(fc.constantFrom(10716,2055,1784),fc.constantFrom('Closed','Pending Fulfillment'),fc.integer({min:0,max:2}),fc.integer({min:0,max:2}),async(itemId,status,executed,billed)=>{
  const b=fixture();b.mutateRows=(rows,id)=>id===101?rows.map(row=>({...row,status_text:status,
   ...(Number(row.item)===itemId?{line_closed:'F',execution_quantity:String(executed),billed_quantity:String(billed)}:{})})):rows;
  if(itemId===10716 && status==='Closed' && !executed && !billed){
   const plan=await prepareSpecialClosurePlan({orders:expected().slice(0,1)},b);
   assert.deepEqual((await applySpecialClosurePlan(plan,b)).verifiedOrderIds,[101]);
  }else await assert.rejects(prepareSpecialClosurePlan({orders:expected().slice(0,1)},b),{status:409});
  assert.equal(b.writes.length,0);
 }),{seed:2609269,numRuns:120});
 // Include the exact production state deterministically as well as generated adversarial cases.
 const b=fixture();b.mutateRows=rows=>rows.map(row=>Number(row.item)===10716?{...row,line_closed:'F'}:row);
 const plan=await prepareSpecialClosurePlan({orders:expected().slice(0,1)},b);
 assert.deepEqual((await applySpecialClosurePlan(plan,b)).verifiedOrderIds,[101]);assert.equal(b.writes.length,0);
});

test('SO-only lost-response closure with a discount recovers the saved plan without writing again', async () => {
 const b=fixture({salesClosed:false});b.mutateRows=rows=>rows.map(row=>Number(row.item)===10716?{...row,line_closed:'F'}:row);
 const plan=JSON.parse(JSON.stringify(await prepareSpecialClosurePlan({orders:expected().slice(0,1)},b)));
 b.loseResponse=true;await assert.rejects(applySpecialClosurePlan(plan,b),/Lost close response/);
 assert.deepEqual((await applySpecialClosurePlan(plan,b)).verifiedOrderIds,[101]);
 assert.deepEqual(b.writes,[{id:101,body:{item:{items:[{line:1,isClosed:true},{line:3,isClosed:true}]}}}]);
});

test('closed-order query evidence must remain complete, unexecuted and exact after preparing the current orders',async()=>{
 for(const mutate of [_rows=>[],rows=>[...rows,rows[0]],rows=>rows.slice(1),
  rows=>rows.map((r,i)=>i? r:{...r,execution_quantity:'1'}),
  rows=>rows.map((r,i)=>i? r:{...r,billed_quantity:'1'}),
  rows=>rows.map((r,i)=>i? r:{...r,line_closed:'F'}),
  rows=>rows.map((r,i)=>i? r:{...r,status_text:'Pending Fulfillment'}),
  rows=>rows.map((r,i)=>i? r:{...r,line_rate:undefined}),
  rows=>rows.map((r,i)=>i? r:{...r,base_quantity:undefined}),
  rows=>rows.map((r,i)=>i? r:{...r,base_quantity:'NaN'}),
  rows=>rows.map((r,i)=>i? r:{...r,line_rate:'NaN'}),
  rows=>rows.map((r,i)=>i? r:{...r,unit_id:'bad'}),
  rows=>rows.map((r,i)=>i? r:{...r,line_rate_percent:'bad'}),
  rows=>rows.map((r,i)=>i? r:{...r,item:'900'})]){
  const b=fixture(),plan=await prepareSpecialClosurePlan({orders:expected()},b);b.mutateRows=(rows,id)=>id===101?mutate(rows):rows;
  await assert.rejects(applySpecialClosurePlan(plan,b));assert.equal(b.writes.length,0);
 }
 const b=fixture(),plan=await prepareSpecialClosurePlan({orders:expected()},b);
 b.remote.get(101)[0].rate=21;
 await assert.rejects(applySpecialClosurePlan(plan,b),{status:409});assert.equal(b.writes.length,0);
});

test('open workflow locks and unrelated errors are not converted into closed evidence',async()=>{
 const b=fixture({salesClosed:false});b.openError=lock();
 await assert.rejects(prepareSpecialClosurePlan({orders:expected()},b),error=>error===b.openError||/workflow/.test(error.message));assert.equal(b.writes.length,0);
 for(const error of [Object.assign(Error('Permission denied'),{status:403}),Error('Network timeout'),Object.assign(lock(),{netsuiteErrorCodes:['OTHER']})]){
  const c=fixture();c.closedError=error;
  await assert.rejects(prepareSpecialClosurePlan({orders:expected()},c),actual=>actual===error);assert.equal(c.writes.length,0);
 }
});

test('a reopened closed baseline and legacy plans without query evidence cannot complete',async()=>{
 const b=fixture(),plan=await prepareSpecialClosurePlan({orders:expected()},b);
 for(const line of b.remote.get(101))line.closed=false;
 await assert.rejects(applySpecialClosurePlan(plan,b),{status:409});assert.equal(b.writes.length,0);
 const c=fixture({salesClosed:false}),legacy=await prepareSpecialClosurePlan({orders:expected()},c);
 for(const order of legacy.orders)for(const line of order.lines)delete line.queryFingerprint;
 for(const line of c.remote.get(101))line.closed=true;
 await assert.rejects(applySpecialClosurePlan(legacy,c),{status:409});assert.equal(c.writes.length,0);
});

test('property: lost-response retries preserve converted quantities and never write a closed order',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:1,max:250}),fc.integer({min:1,max:50}),fc.boolean(),async(qty,conversion,salesClosed)=>{
  const b=fixture({salesClosed,conversion}),orders=expected();
  for(const order of orders){order.lines[0].quantity=qty;b.remote.get(order.id)[0].quantity=qty;}
  const plan=await prepareSpecialClosurePlan({orders},b);b.loseResponse=true;
  await assert.rejects(applySpecialClosurePlan(plan,b),/Lost close response/);
  assert.deepEqual((await applySpecialClosurePlan(plan,b)).verifiedOrderIds,[102,101]);
  assert.deepEqual(b.writes.map(w=>w.id),salesClosed?[102]:[102,101]);
  await applySpecialClosurePlan(plan,b);assert.equal(b.writes.length,salesClosed?1:2);
 }),{seed:260926,numRuns:35});
});

test('property: changed closed evidence or an open workflow lock prevents every write',async()=>{
 await fc.assert(fc.asyncProperty(fc.constantFrom('rate','quantity','description'),fc.integer({min:1,max:100}),async(field,delta)=>{
  const b=fixture(),plan=await prepareSpecialClosurePlan({orders:expected()},b);
  b.remote.get(101)[0][field]=field==='description'?`Changed ${delta}`:b.remote.get(101)[0][field]+delta;
  await assert.rejects(applySpecialClosurePlan(plan,b),{status:409});assert.equal(b.writes.length,0);
  const c=fixture({salesClosed:false});c.openError=lock();
  await assert.rejects(prepareSpecialClosurePlan({orders:expected()},c));assert.equal(c.writes.length,0);
 }),{seed:260927,numRuns:25});
});

test('SCM closure alerts and queue priority clear once confirmation is no longer required',()=>{
 assert.equal(typeof queue.specialClosureNeedsScm,'function');
 const pending={id:1,closeStatus:'closure_pending',closureReview:{id:'review',status:'pending'}};
 const attention={id:2,closeStatus:'closure_pending',closureReview:{id:'review2',status:'attention'}};
 const adjustment={id:3,quantityReviewPending:true},ordinary={id:4};
 assert.deepEqual([ordinary,adjustment,pending,attention].sort(queue.compareSpecialScmQueue).map(d=>d.id),[1,2,3,4]);
 assert.match(queue.specialClosureCardAlert(pending),/Closure requested · SCM confirmation required/);
 assert.match(queue.specialClosureCardAlert(attention),/Closure incomplete · SCM retry required/);
 assert.match(queue.specialClosureQueueAlert([pending,attention,ordinary]),/2 closure requests require SCM confirmation/);
 assert.match(queue.specialClosureQueueAlert([pending]),/1 closure request requires SCM confirmation/);
 for(const d of [ordinary,{...pending,closeStatus:'closed'},{...pending,closureReview:{id:'review',status:'approved'}},
  {...pending,closureReview:{id:'review',status:'rejected'}},{...pending,closureReview:{id:'review',status:'applying'}},
  {...pending,closureReview:{status:'pending'}}]){
  assert.equal(queue.specialClosureNeedsScm(d),false);assert.equal(queue.specialClosureCardAlert(d),'');
  assert.equal(queue.specialClosureQueueAlert([d]),'');
 }
});

test('remaining-order closure recovers a workflow-locked closed record with unchanged posted quantities',async()=>{
 const b=fixture({salesClosed:false});
 b.mutateRows=rows=>rows.map(row=>({...row,execution_quantity:5,billed_quantity:5}));
 const plan=await prepareSpecialClosurePlan({orders:expected(),closeRemaining:true},b);
 b.loseResponse=true;await assert.rejects(applySpecialClosurePlan(plan,b),/Lost close response/);
 assert.deepEqual((await applySpecialClosurePlan(plan,b)).verifiedOrderIds,[102,101]);
 assert.deepEqual(b.writes.map(w=>w.id),[102,101]);
 for(const order of plan.orders)for(const line of order.lines)assert.deepEqual([line.executedQuantity,line.billedQuantity],[5,5]);
});
