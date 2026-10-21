import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {createSpecialQueueLoader,specialQueueEventRelevant} from '../../../public/special-stock-queue.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('queue coalesces duplicate loads, ignores obsolete responses and does not apply unchanged results',async()=>{
 const pending=[],accepted=[];let loading=false;
 const q=createSpecialQueueLoader({read:key=>{const d=deferred();pending.push({key,...d});return d.promise;},accept:v=>accepted.push(v),blocked:()=>false,loading:v=>{loading=v;},error:e=>{throw e;}});
 const a=q.load('one'),duplicate=q.load('one');assert.equal(pending.length,1);
 const b=q.load('two');pending[1].resolve({rows:[2]});await b;pending[0].resolve({rows:[1]});await Promise.all([a,duplicate]);
 assert.deepEqual(accepted,[{rows:[2]}]);assert.equal(loading,false);
 await q.load('two');assert.equal(pending.length,2);
 const refresh=q.load('two',{force:true});pending[2].resolve({rows:[2]});await refresh;assert.equal(accepted.length,1);
});
test('queue defers invalidated results while editing and retries safely',async()=>{
 let editing=false,calls=0;const accepted=[],d=deferred();
 const q=createSpecialQueueLoader({read:()=>{calls++;return calls===1?d.promise:Promise.resolve(2);},accept:v=>accepted.push(v),blocked:()=>editing,loading:()=>{},error:e=>{throw e;}});
 const first=q.load('a');editing=true;d.resolve(1);await first;assert.deepEqual(accepted,[]);
 await q.load('a');assert.equal(calls,1);editing=false;await q.load('a');assert.deepEqual(accepted,[2]);
 q.invalidate();await q.load('a');assert.equal(calls,3);assert.deepEqual(accepted,[2]);
});
test('property: regardless of completion order, only the latest requested queue is accepted',async()=>{
 await fc.assert(fc.asyncProperty(fc.array(fc.integer({min:1,max:10}),{minLength:2,maxLength:10}),async values=>{
  const ds=values.map(deferred),accepted=[];let n=0;
  const q=createSpecialQueueLoader({read:()=>ds[n++].promise,accept:v=>accepted.push(v),blocked:()=>false,loading:()=>{},error:e=>{throw e;}});
  const work=values.map((_,i)=>q.load(String(i)));
  for(let i=values.length-1;i>=0;i--)ds[i].resolve(values[i]);await Promise.all(work);
  assert.deepEqual(accepted,[values.at(-1)]);
 }),{seed:261001,numRuns:40});
});
test('property: order events refresh only cases with the matching SO or PO',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:1e7}),fc.boolean(),(id,match)=>{
  assert.equal(specialQueueEventRelevant({type:'dispatch.orders.updated',payload:{orderId:id}},[{salesOrderId:match?id:id+1,purchaseOrderId:id+2}]),match);
  assert.equal(specialQueueEventRelevant({type:'special-stock-request.updated'},[]),true);
  assert.equal(specialQueueEventRelevant({type:'unrelated'},[]),false);
 }),{seed:261002,numRuns:40});
});


test('queue reports a failed read, retries, and drains an event received during an in-flight read',async()=>{
 let fail=true;const accepted=[],errors=[],pending=[];
 const q=createSpecialQueueLoader({read:()=>{if(fail)return Promise.reject(Error('Offline'));const d=deferred();pending.push(d);return d.promise;},accept:v=>accepted.push(v),blocked:()=>false,loading:()=>{},error:e=>errors.push(e.message)});
 await q.load('a');assert.deepEqual(errors,['Offline']);assert.equal(q.pending,true);
 fail=false;const first=q.load('a');q.invalidate();pending[0].resolve(1);await first;
 assert.equal(pending.length,2);pending[1].resolve(2);await q.load('a');assert.deepEqual(accepted,[2]);assert.equal(q.pending,false);
});

test('a successful retry clears a previous error even when the case data did not change',async()=>{
 let fail=false,calls=0;const q=createSpecialQueueLoader({read:async()=>{if(fail)throw Error('Offline');return 1;},accept:()=>{calls++;},blocked:()=>false,loading:()=>{},error:()=>{}});
 await q.load('a');fail=true;await q.load('a',{force:true});fail=false;await q.load('a',{force:true});assert.equal(calls,2);
});
