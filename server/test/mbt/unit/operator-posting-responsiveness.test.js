import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../../public/operator.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function pollOperatorNetSuitePostingJob('),source.indexOf('async function editReloadPacking('));
const flush=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};
function harness(api){
 const timers=new Map();let sequence=0;
 const context=vm.createContext({Date,operatorPostingPollWakeups:new Map(),api,
  setTimeout:(fn,ms)=>{assert.equal(ms,1000);timers.set(++sequence,fn);return sequence;},
  clearTimeout:id=>timers.delete(id)});
 vm.runInContext(code,context);
 const fire=()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}};
 const wake=jobId=>{for(const fn of context.operatorPostingPollWakeups.get(jobId)||[])fn();};
 return {context,timers,fire,wake,poll:context.pollOperatorNetSuitePostingJob};
}
test('posting checks an already-completed job immediately and releases subscriptions',async()=>{
 let calls=0;
 const h=harness(async()=>{calls++;return {status:'completed',result:{verified:true}};});
 const done=h.poll('one');await flush();
 assert.equal(calls,1,'Do not add a one-second delay before the first read');
 assert.equal((await done).verified,true);assert.equal(h.timers.size,0);assert.equal(h.context.operatorPostingPollWakeups.size,0);
});
test('own completion event wakes the authorized read; unrelated events do not',async()=>{
 let calls=0;
 const h=harness(async()=>++calls===3?{status:'completed',result:{verified:true}}:{status:'posting',steps:[]});
 let finished=false;const done=h.poll('one').then(result=>{finished=true;return result;});
 await flush();h.wake('unrelated');await flush();assert.equal(calls,1);
 h.wake('one');await flush();assert.equal(calls,2);assert.equal(finished,false,'Event itself cannot confirm completion');
 h.wake('one');await flush();assert.equal((await done).verified,true);assert.equal(calls,3);assert.equal(h.timers.size,0);
});
test('an event during an in-flight read queues one subsequent read without overlap',async()=>{
 let release,calls=0,active=0,maxActive=0;
 const h=harness(async()=>{calls++;active++;maxActive=Math.max(maxActive,active);if(calls===1)await new Promise(resolve=>{release=resolve;});active--;return calls===1?{status:'posting'}:{status:'completed',result:{verified:true}};});
 const done=h.poll('one');await flush();assert.equal(calls,1);
 for(let index=0;index<10;index++)h.wake('one');assert.equal(calls,1);
 release();await flush();assert.equal((await done).verified,true);assert.equal(calls,2);assert.equal(maxActive,1);assert.equal(h.timers.size,0);
});
for(const status of ['completed','attention','failed','network']){
 test(`missed event falls back to polling and cleans up on ${status}`,async()=>{
  let calls=0;
  const h=harness(async()=>{if(++calls===1)return {status:'posting'};if(status==='network')throw new Error('Network unavailable');return {status,result:{verified:true},lastError:'Rejected'};});
  const done=h.poll('one');done.catch(()=>{});await flush();assert.equal(calls,1);assert.equal(h.timers.size,1);
  h.fire();await flush();
  if(status==='completed')assert.equal((await done).verified,true);else await assert.rejects(done,/attention|Rejected|Network unavailable/);
  assert.equal(calls,2);assert.equal(h.context.operatorPostingPollWakeups.size,0);assert.equal(h.timers.size,0);
 });
}
