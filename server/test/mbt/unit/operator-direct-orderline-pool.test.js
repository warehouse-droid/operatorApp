import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { createOperatorNetSuiteRequestPool } from "../../../src/operator-netsuite-request-pool.js";

async function exercise(limit, count, fail) {
  const pool=createOperatorNetSuiteRequestPool(limit);
  let active=0,peak=0;const started=[];
  const outcomes=await Promise.allSettled(Array.from({length:count},(_,index)=>pool.run(async()=>{
    started.push(index);active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,1));active--;
    if(index===fail) {throw new Error("expected failure");}
    return index;
  })));
  assert.equal(peak,Math.min(limit,count));assert.equal(active,0);
  assert.deepEqual(started,Array.from({length:count},(_,index)=>index));
  assert.equal(outcomes.filter(row=>row.status==="rejected").length,fail<count?1:0);
  assert.equal(await pool.run(async()=>"after failure"),"after failure");
}

test("the shared pool permits three requests and releases slots after failures",()=>exercise(3,12,2));
test("invalid concurrency limits are rejected",()=>{
  for(const limit of [0,-1,1.5,NaN,Infinity]) {assert.throws(()=>createOperatorNetSuiteRequestPool(limit));}
});
test("property: scheduling is bounded, FIFO and live after a rejected task",async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:3}),fc.integer({min:1,max:15}),fc.integer({min:0,max:15}),exercise),{seed:160920,numRuns:32});
});
