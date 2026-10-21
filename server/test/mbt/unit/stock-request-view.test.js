import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpecialQueueLoader} from '../../../public/special-stock-queue.js';

const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(read) {
  const accepted=[],errors=[];
  const queue=createSpecialQueueLoader({read,accept:value=>accepted.push(value),error:error=>errors.push(error),blocked:()=>false,loading:()=>{},autoReload:false});
  return {queue,accepted,errors};
}
test('background queue checks flag changes without accepting or changing the displayed snapshot',async()=>{
  let value={requests:[{id:1,revision:1}]};const f=fixture(async()=>structuredClone(value));
  await f.queue.load('sales');assert.equal(await f.queue.check('sales'),false);
  value.requests[0].revision++;
  assert.equal(await f.queue.check('sales'),true);assert.equal(f.queue.pending,true);
  assert.deepEqual(f.accepted,[{requests:[{id:1,revision:1}]}]);
  await f.queue.load('sales');assert.equal(f.accepted.at(-1).requests[0].revision,2);assert.equal(f.queue.pending,false);
});
test('an event during explicit loading leaves a pending update without starting another load',async()=>{
  let calls=0;const gate=deferred(),f=fixture(()=>{calls++;return gate.promise;});
  const work=f.queue.load('scm');f.queue.invalidate();gate.resolve({requests:[1]});await work;
  assert.equal(calls,1);assert.deepEqual(f.accepted,[{requests:[1]}]);assert.equal(f.queue.pending,true);
});
test('failed background checks are silent and retain the working queue',async()=>{
  let fail=false;const f=fixture(async()=>{if(fail)throw Error('Offline');return 1;});
  await f.queue.load('scm');fail=true;
  assert.equal(await f.queue.check('scm'),false);assert.deepEqual(f.errors,[]);assert.deepEqual(f.accepted,[1]);
  assert.equal(f.queue.pending,false);
});
test('a background response cannot invalidate a later explicit load or a different filter',async()=>{
  const gate=deferred();let calls=0;
  const f=fixture(async()=>++calls===2 ? gate.promise : calls);
  await f.queue.load('one');const check=f.queue.check('one');await f.queue.load('two');gate.resolve(200);await check;
  assert.equal(f.queue.pending,false);assert.deepEqual(f.accepted,[1,3]);assert.equal(await f.queue.check('one'),false);
});
