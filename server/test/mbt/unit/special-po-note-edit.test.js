import assert from 'node:assert/strict';
import test from 'node:test';
import {readSpecialPurchaseOrderNote,updateSpecialPurchaseOrderNote} from '../../../src/special-stock-purchase-order-note-adapter.js';

const identity={purchaseOrderId:1030348,purchaseOrderRef:'POB03976',vendorId:331};
function fixture({note='for SOB121819',lost=false,ignore=false,ref='POB03976',vendorId=331}={}) {
  const record={id:'1030348',tranId:ref,entity:{id:String(vendorId)},memo:'Pickering Yard - Unilock',custbody7:note,
    item:{items:[{item:{id:'2055'},quantity:24,rate:33.87},{item:{id:'1784'},quantity:1,rate:35}]}};
  const calls=[];
  return {record,calls,boundary:{rest:async(path,options={})=>{
    calls.push({path,...options});
    if(options.method==='PATCH') {
      if(!ignore)record.custbody7=options.body.custbody7;
      if(lost)throw new Error('Response lost after commit');
      return {status:204};
    }
    return {data:JSON.parse(JSON.stringify(record))};
  }}};
}

test('reading the real PO Note is read-only and never reads its Remark as Note',async()=>{
  const f=fixture();
  assert.equal(await readSpecialPurchaseOrderNote(identity,f.boundary),'for SOB121819');
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].path,'/record/v1/purchaseOrder/1030348');
  assert.equal(f.calls[0].method,'GET');
});

test('Special Request Note edits PATCH only custbody7 on the linked real PO',async()=>{
  const f=fixture(),before=JSON.parse(JSON.stringify(f.record));
  assert.equal(await updateSpecialPurchaseOrderNote({...identity,note:'Call for SOB121819',expectedNote:'for SOB121819'},f.boundary),'Call for SOB121819');
  assert.deepEqual(f.calls.filter(call=>call.method==='PATCH'),[
    {path:'/record/v1/purchaseOrder/1030348',method:'PATCH',body:{custbody7:'Call for SOB121819'}}]);
  const {custbody7,...other}=f.record,{custbody7:old,...previous}=before;
  assert.equal(custbody7,'Call for SOB121819');assert.equal(old,'for SOB121819');assert.deepEqual(other,previous);
});

test('unchanged Notes and retries after a lost response do not write the PO again',async()=>{
  const f=fixture({lost:true});
  const input={...identity,note:'New Note',expectedNote:'for SOB121819'};
  assert.equal(await updateSpecialPurchaseOrderNote(input,f.boundary),'New Note');
  assert.equal(await updateSpecialPurchaseOrderNote(input,f.boundary),'New Note');
  assert.equal(f.calls.filter(call=>call.method==='PATCH').length,1);
});

test('clearing an actual PO Note sends an empty custbody7 and verifies it',async()=>{
  const f=fixture();
  assert.equal(await updateSpecialPurchaseOrderNote({...identity,note:'',expectedNote:'for SOB121819'},f.boundary),'');
  assert.deepEqual(f.calls.find(call=>call.method==='PATCH').body,{custbody7:''});
});

test('stale Notes and wrong PO identities fail before any remote write',async()=>{
  for(const options of [{note:'Someone else edited this Note'},{ref:'SPLIT-PO'},{vendorId:99}]) {
    const f=fixture(options);
    await assert.rejects(()=>updateSpecialPurchaseOrderNote({...identity,note:'New Note',expectedNote:'for SOB121819'},f.boundary),{status:409});
    assert.equal(f.calls.some(call=>call.method==='PATCH'),false);
  }
});

test('invalid or missing Note concurrency inputs fail before reading NetSuite',async()=>{
  for(const input of [{note:null,expectedNote:''},{note:1,expectedNote:''},{note:'x'.repeat(4001),expectedNote:''},{note:'Valid'},
    {purchaseOrderId:-1,note:'Valid',expectedNote:''}]) {
    const f=fixture();
    await assert.rejects(()=>updateSpecialPurchaseOrderNote({...identity,...input},f.boundary));
    assert.equal(f.calls.length,0);
  }
});

test('an unverified Note write fails instead of reporting success',async()=>{
  const f=fixture({ignore:true});
  await assert.rejects(()=>updateSpecialPurchaseOrderNote({...identity,note:'New Note',expectedNote:'for SOB121819'},f.boundary),{status:502});
});
