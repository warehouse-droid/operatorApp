import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {normalizeDeliveryNetSuiteValues,readDeliveryNetSuite,updateDeliveryNetSuite} from '../../../src/delivery-instruction-netsuite.js';
const options={seed:29670929,numRuns:200};
const date=fc.date({min:new Date('1000-01-01T00:00:00Z'),max:new Date('9999-12-31T00:00:00Z'),noInvalidDate:true}).map(d=>d.toISOString().slice(0,10));
const valid=fc.record({memo:fc.string({maxLength:300}).filter(v=>!v.includes('\0')),shipDate:fc.oneof(date,fc.constant('')),deliverByDate:fc.oneof(date,fc.constant(''))});
test('properties: date-only values and lossless notes normalize idempotently',()=>{
 fc.assert(fc.property(valid,input=>{
  const actual=normalizeDeliveryNetSuiteValues(input);
  assert.equal(actual.memo,input.memo.replace(/\r\n?/g,'\n'));assert.equal(actual.shipDate,input.shipDate);assert.equal(actual.deliverByDate,input.deliverByDate);
  assert.deepEqual(normalizeDeliveryNetSuiteValues(actual),actual);
 }),options);
});
test('properties: exact mapped patch, untouched fields and idempotent retry',async()=>{
 await fc.assert(fc.asyncProperty(valid,valid,async(baseline,targetInput)=>{
  const before=normalizeDeliveryNetSuiteValues(baseline),target=normalizeDeliveryNetSuiteValues(targetInput);
  const record={id:'7',tranId:'SO7',location:{id:'1'},custbody3:{id:'2'},status:{id:'B'},custbody7:before.memo,shipDate:before.shipDate,custbody4:before.deliverByDate,memo:'Standard memo untouched',item:{items:[{quantity:123,rate:45}]}};
  const patches=[],boundary={rest:async(path,opts={})=>{assert.equal(path,'/record/v1/salesOrder/7');if(opts.method==='PATCH'){patches.push(opts.body);Object.assign(record,opts.body);}return{data:structuredClone(record)};}};
  const expected=await readDeliveryNetSuite(7,boundary),input={orderId:7,expected,values:target};
  const result=await updateDeliveryNetSuite(input,boundary);assert.deepEqual(result.values,target);
  const body={};for(const[key,field]of[['memo','custbody7'],['shipDate','shipDate'],['deliverByDate','custbody4']])if(before[key]!==target[key])body[field]=target[key]||null;
  assert.deepEqual(patches,Object.keys(body).length?[body]:[]);
  await updateDeliveryNetSuite(input,boundary);assert.equal(patches.length,Object.keys(body).length?1:0);
  assert.equal(record.memo,'Standard memo untouched');assert.deepEqual(record.item,{items:[{quantity:123,rate:45}]});
 }),options);
});
test('properties: invalid dates, types and extra writable fields always fail closed',()=>{
 fc.assert(fc.property(valid,fc.constantFrom('2026-02-30','2027-02-29','2026-13-01','2026-00-01','1/2/2026','0000-01-01','2026-01-01T00:00:00Z'),(input,invalid)=>{
  assert.throws(()=>normalizeDeliveryNetSuiteValues({...input,shipDate:invalid}),e=>e.status===400);
  assert.throws(()=>normalizeDeliveryNetSuiteValues({...input,memo:{text:'no'}}),e=>e.status===400);
  assert.throws(()=>normalizeDeliveryNetSuiteValues({...input,location:28}),e=>e.status===400);
 }),options);
});
test('properties: stale memo or moved yard rejects all writes even with a valid target',async()=>{
 await fc.assert(fc.asyncProperty(valid,fc.boolean(),async(input,moved)=>{
  const record={id:'7',tranId:'SO7',location:{id:'1'},custbody3:{id:'2'},status:{id:'B'},custbody7:'original',shipDate:'2026-10-01',custbody4:'2026-10-02'};
  let writes=0;const boundary={rest:async(_path,opts={})=>{if(opts.method==='PATCH')writes++;return{data:structuredClone(record)};}};
  const expected=await readDeliveryNetSuite(7,boundary);
  if(moved)record.location.id='28';else record.custbody7='concurrent change';
  await assert.rejects(()=>updateDeliveryNetSuite({orderId:7,expected,values:{...input,memo:'requested change'}},boundary),e=>e.status===409);
  assert.equal(writes,0);
 }),options);
});
