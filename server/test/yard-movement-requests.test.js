import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {mutate} from './support/yard-movement-performance-mutations.mjs';
const file='public/yard-movement-requests.js';
const source=mutate(file,readFileSync(file,'utf8'));
function setup(){
  const window={},calls=[];
  runInNewContext(source,{window,AbortController});
  const reads=window.MBBSMovementReads.create((path,{signal})=>new Promise((resolve,reject)=>calls.push({path,signal,resolve,reject})));
  return {reads,calls};
}
test('pending detail clicks deduplicate, completed refreshes read fresh data',async()=>{
  const {reads,calls}=setup(),seen=[];
  const first=reads.run('detail','/A',data=>seen.push(data));
  const same=reads.run('detail','/A',data=>seen.push(data));
  assert.equal(first,same);assert.equal(calls.length,1);assert.equal(reads.pending('detail'),true);
  calls[0].resolve('old');await first;assert.deepEqual(seen,['old']);
  assert.equal(reads.pending('detail'),false);
  const refreshed=reads.run('detail','/A',data=>seen.push(data));assert.equal(calls.length,2);
  calls[1].resolve('fresh');await refreshed;assert.deepEqual(seen,['old','fresh']);
});
test('latest selection wins even when transport ignores abort',async()=>{
  const {reads,calls}=setup(),seen=[];
  const first=reads.run('detail','/A',data=>seen.push(data));
  const second=reads.run('detail','/B',data=>seen.push(data));
  assert.equal(calls[0].signal.aborted,true);
  calls[0].resolve('stale');await first;assert.deepEqual(seen,[]);
  assert.equal(reads.pending('detail'),true);
  calls[1].resolve('current');await second;assert.deepEqual(seen,['current']);
});
test('cancel invalidates results and stale errors without cancelling another channel',async()=>{
  const {reads,calls}=setup(),seen=[];
  const search=reads.run('search','/old',data=>seen.push(data));
  const detail=reads.run('detail','/A',data=>seen.push(data));
  reads.cancel('search');assert.equal(calls[0].signal.aborted,true);assert.equal(calls[1].signal.aborted,false);
  calls[0].reject(new Error('old failure'));await search;
  calls[1].resolve('detail');await detail;assert.deepEqual(seen,['detail']);
});
test('current errors stay visible and the same request can be retried',async()=>{
  const {reads,calls}=setup(),seen=[];
  const first=reads.run('detail','/A',data=>seen.push(data));
  calls[0].reject(new Error('temporary failure'));await assert.rejects(first,/temporary failure/);
  assert.equal(reads.pending('detail'),false);
  const retry=reads.run('detail','/A',data=>seen.push(data));calls[1].resolve('ok');await retry;
  assert.deepEqual(seen,['ok']);
});
