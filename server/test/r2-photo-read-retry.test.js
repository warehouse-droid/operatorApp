import test from 'node:test';
import assert from 'node:assert/strict';
import {readR2Object} from '../src/photo-upload.js';

const ticket={objectUrl:'https://r2.invalid/object?key=damage%2Fa.jpg',token:'signed'};
const image=Buffer.from([0xff,0xd8,0xff,0xd9]);
function connectTimeout() {
  // Same shape Node's undici fetch throws when the R2 worker edge cannot be reached.
  return Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('Connect Timeout Error'),{code:'UND_ERR_CONNECT_TIMEOUT'})});
}
function harness(steps) {
  const calls=[],waits=[];
  const fetch=async(url,init)=>{
    calls.push({url,init});const step=steps[Math.min(calls.length,steps.length)-1];
    if(step instanceof Error) {throw step;}
    return new Response(step.body ?? image,{status:step.status,headers:{'content-type':step.type || 'image/jpeg'}});
  };
  return {calls,waits,options:{fetch,sleep:async ms=>{waits.push(ms);}}};
}

test('a transient R2 connect timeout is retried and the photo is returned',async()=>{
  const {calls,waits,options}=harness([connectTimeout(),{status:200}]);
  const {response,body}=await readR2Object(ticket,options);
  assert.equal(response.status,200);assert.deepEqual(body,image);
  assert.equal(calls.length,2);assert.deepEqual(waits,[500]);
  for(const call of calls) {
    assert.equal(call.url,ticket.objectUrl);assert.equal(call.init.headers.Authorization,'Bearer signed');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test('Cloudflare/R2 gateway statuses are retried before success',async()=>{
  const {calls,options}=harness([{status:522,body:'<html>edge</html>',type:'text/html'},{status:503,body:'busy',type:'text/plain'},{status:200}]);
  const {response,body}=await readR2Object(ticket,options);
  assert.equal(response.status,200);assert.deepEqual(body,image);assert.equal(calls.length,3);
});

test('a missing or denied object is relayed once without retry',async()=>{
  for(const status of [400,401,403,404,410]) {
    const {calls,options}=harness([{status,body:'Object not found',type:'text/plain'}]);
    const {response,body}=await readR2Object(ticket,options);
    assert.equal(response.status,status);assert.equal(body.toString('utf8'),'Object not found');assert.equal(calls.length,1);
  }
});

test('exhausted transient failures return a clear 502, never raw "fetch failed" or an edge HTML page',async(t)=>{
  t.mock.method(console,'warn',()=>{});
  for(const steps of [[connectTimeout()],[{status:522,body:'<html>edge</html>',type:'text/html'}]]) {
    const {calls,waits,options}=harness(steps);
    await assert.rejects(readR2Object(ticket,options),error=>{
      assert.equal(error.status,502);assert.equal(error.code,'PHOTO_STORAGE_UNAVAILABLE');
      assert.doesNotMatch(error.message,/fetch failed|html/i);assert.match(error.message,/try again/i);
      return true;
    });
    assert.equal(calls.length,3);assert.deepEqual(waits,[500,1500]);
  }
});

test('retries stay inside the total time budget so browser callers do not time out first',async(t)=>{
  t.mock.method(console,'warn',()=>{});
  let clock=0;const timeouts=[];
  const fetch=async(url,init)=>{clock+=10000;timeouts.push(init.signal);throw connectTimeout();};
  const waits=[];
  await assert.rejects(readR2Object(ticket,{fetch,budgetMs:21000,sleep:async ms=>{waits.push(ms);clock+=ms;},now:()=>clock}),/temporarily unreachable/);
  // 10s + 0.5s + 10s uses the 21s budget: the backoff is clipped and no third attempt starts.
  assert.equal(timeouts.length,2);assert.deepEqual(waits,[500,0]);assert.ok(clock<=21000);
});
