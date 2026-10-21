import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeliveryRequestExpiryRuntime} from '../../../src/delivery-request-expiry.js';
test('expiry ticks never overlap and a logged failure does not stop later reminders',async()=>{
  let calls=0,release;
  const errors=[];
  const runtime=createDeliveryRequestExpiryRuntime({service:{tick:async()=>{
    calls++;
    if(calls===1) {await new Promise(resolve=>{release=resolve;});throw new Error('database unavailable');}
  }},logger:{error:(...args)=>errors.push(args)}});
  const first=runtime.tick();await runtime.tick();assert.equal(calls,1);
  release();await first;
  assert.deepEqual(errors,[['Delivery approval expiry failed:','database unavailable']]);
  await runtime.tick();assert.equal(calls,2);
});
test('scheduler starts immediately only once and stop unregisters its bounded interval',async context=>{
  const timers=[],cleared=[];let calls=0;
  context.mock.method(globalThis,'setInterval',(callback,ms)=>{const timer={callback,ms,unref:()=>{timer.unreferenced=true;}};timers.push(timer);return timer;});
  context.mock.method(globalThis,'clearInterval',timer=>cleared.push(timer));
  const runtime=createDeliveryRequestExpiryRuntime({service:{tick:async()=>{calls++;}}});
  runtime.start();runtime.start();await Promise.resolve();
  assert.equal(calls,1);assert.equal(timers.length,1);assert.equal(timers[0].ms,60000);assert.equal(timers[0].unreferenced,true);
  timers[0].callback();await Promise.resolve();assert.equal(calls,2);
  runtime.stop();runtime.stop();assert.deepEqual(cleared,[timers[0]]);
});
