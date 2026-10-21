import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {createDeliveryRequestDocuments} from '../../../src/delivery-request-documents.js';
import {fetchEstimateRecordFromNetSuite} from '../../../src/netsuite.js';

const record={id:'51',tranId:'ESTB123',location:{id:'1'},entity:{refName:'Test Customer'},tranDate:'2026-10-13',
  currency:{refName:'CAD'},shippingAddress:{addrText:'100 Test Road'},memo:'Call first',subtotal:60,taxTotal:7.8,total:67.8,
  item:{items:[{item:{refName:'Gravel'},description:'Gravel',quantity:2,units:{refName:'Yard'},rate:30,amount:60,
    custcol_plt:1.25,custcol_lyr:2,custcol_sec:0,custcol_pcs:8}]}};
function fixture(overrides={}) {
  const calls=[];
  const documents=createDeliveryRequestDocuments({
    findEstimate:async ref=>{calls.push(['find',ref]);return {id:51,tranid:'ESTB123',location:1};},
    readEstimate:async id=>{calls.push(['read',id]);return record;},
    getSalesOrder:async(ref,context)=>{calls.push(['order',ref,context]);return {orderId:91,orderRef:'SO123'};},
    fetchSalesOrderPdf:async id=>{calls.push(['pdf',id]);return {buffer:Buffer.from('%PDF-1.4 fixture'),filename:'SO123.pdf'};},...overrides});
  return {documents,calls};
}
test('optional EST references normalize without reading documents, while malformed values are rejected before network access',async()=>{
  const {documents,calls}=fixture();
  assert.equal(await documents.validateEstimate('',1),null);
  assert.deepEqual(await documents.validateEstimate(' estb123 ',1),{reference:'ESTB123',id:51});
  assert.deepEqual(calls,[['find','ESTB123']]);
  for(const ref of ['SO123',"EST1' OR 1=1",'EST',{},12,'EST'+'1'.repeat(80)]) {
    await assert.rejects(documents.validateEstimate(ref,1),{code:'DELIVERY_REQUEST_INVALID'});
  }
  assert.equal(calls.length,1);
});
test('estimate previews expose live original item values and totals after checking yard and document identity',async()=>{
  const {documents,calls}=fixture();
  const preview=await documents.estimate('ESTB123',1);
  assert.equal(preview.reference,'ESTB123');assert.equal(preview.customerName,'Test Customer');assert.equal(preview.address,'100 Test Road');
  assert.equal(preview.total,67.8);assert.equal(preview.tax,7.8);assert.equal(preview.lines[0].quantity,2);
  assert.equal(preview.lines[0].unit,'Yard');assert.equal(preview.lines[0].rate,30);assert.equal(preview.lines[0].amount,60);
  assert.deepEqual(['pallets','layers','sections','pieces'].map(key=>preview.lines[0][key]),[1.25,2,0,8]);
  assert.deepEqual(calls,[['find','ESTB123'],['read',51]]);
});
test('estimate packing quantities preserve blanks, zeroes and saved decimals without converting or changing source lines',async()=>{
  const lines=[{description:'Note'},{quantity:40,custcol_plt:0,custcol_lyr:0,custcol_sec:0,custcol_pcs:0},
    {quantity:126,custcol_plt:1.125,custcol_lyr:'2.75',custcol_sec:null,custcol_pcs:48}];
  const original=structuredClone(lines),{documents}=fixture({readEstimate:async()=>({...record,item:{items:lines}})});
  const preview=await documents.estimate('ESTB123',1);
  assert.deepEqual(preview.lines.map(line=>['pallets','layers','sections','pieces'].map(key=>line[key])),
    [[null,null,null,null],[0,0,0,0],[1.125,'2.75',null,48]]);
  assert.deepEqual(preview.lines.map(line=>line.quantity),[undefined,40,126]);
  assert.deepEqual(lines,original);
});
test('property: all four quotation packing quantities remain independent and exactly match their saved source fields',async()=>{
  const quantity=fc.option(fc.double({min:0,max:10000,noNaN:true}),{nil:null});
  await fc.assert(fc.asyncProperty(fc.tuple(quantity,quantity,quantity,quantity),async values=>{
    const line={quantity:137,custcol_plt:values[0],custcol_lyr:values[1],custcol_sec:values[2],custcol_pcs:values[3]};
    const {documents}=fixture({readEstimate:async()=>({...record,item:{items:[line]}})});
    const {lines}=await documents.estimate('ESTB123',1);
    assert.deepEqual(['pallets','layers','sections','pieces'].map(key=>lines[0][key]),values);
    assert.equal(lines[0].quantity,137);
  }),{seed:14102026,numRuns:80});
});
test('missing, ambiguous or other-yard ESTs and identity changes cannot disclose previews',async()=>{
  for(const identity of [null,{id:51,tranid:'ESTB123',location:28},{id:0,tranid:'ESTB123',location:1},{id:51,tranid:'ESTB124',location:1}]) {
    const {documents,calls}=fixture({findEstimate:async()=>identity});
    await assert.rejects(documents.estimate('ESTB123',1));assert.ok(!calls.some(call=>call[0]==='read'));
  }
  for(const changed of [{...record,id:'52'},{...record,tranId:'ESTB124'},{...record,location:{id:'28'}}]) {
    const {documents}=fixture({readEstimate:async()=>changed});
    await assert.rejects(documents.estimate('ESTB123',1),{code:'DELIVERY_DOCUMENT_CHANGED'});
  }
});
test('SO preview authorizes the requesting yard and returns native PDF bytes without rebuilding the order',async()=>{
  const {documents,calls}=fixture();
  const pdf=await documents.salesOrder('SO123',1);
  assert.equal(pdf.buffer.toString(),'%PDF-1.4 fixture');
  assert.deepEqual(calls,[['order','SO123',{authorizedOrderingLocationIds:[1]}],['pdf',91]]);
});
test('default NetSuite adapters perform exact estimate lookup, expanded reads and native SO PDF fetches',async()=>{
  const calls=[];
  const remote={suiteql:async sql=>{calls.push(['query',sql]);return {items:[{id:51,tranid:'ESTB123',location:1}]};},
    fetchEstimateRecordFromNetSuite:async id=>{calls.push(['estimate',id]);return record;},
    fetchSalesOrderPdfFromNetSuite:async id=>{calls.push(['pdf',id]);return {buffer:Buffer.from('%PDF-1.4 remote')};}};
  const documents=createDeliveryRequestDocuments({loadNetSuite:async()=>remote,getSalesOrder:async()=>({orderId:91})});
  assert.equal((await documents.estimate(' estb123 ',1)).total,67.8);
  assert.match(calls[0][1],/t.type='Estimate' AND UPPER\(t.tranid\)='ESTB123'/);
  assert.match(calls[0][1],/COALESCE\(t.location,tl.location\) AS location/);
  assert.match(calls[0][1],/tl.transaction=t.id AND tl.mainline='T'/);
  assert.deepEqual(calls[1],['estimate',51]);assert.equal((await documents.salesOrder('SO123',1)).buffer.toString(),'%PDF-1.4 remote');
  remote.suiteql=async()=>({items:[{id:51},{id:52}]});
  await assert.rejects(documents.validateEstimate('ESTB123',1),{code:'DELIVERY_DOCUMENT_AMBIGUOUS'});
  remote.suiteql=async()=>({items:[]});await assert.rejects(documents.validateEstimate('ESTB123',1),{status:404});
});
test('estimate record transport uses only an expanded GET and rejects invalid IDs before remote access',async()=>{
  const calls=[],rest=async(path,options)=>{calls.push([path,options]);return {data:record};};
  assert.deepEqual(await fetchEstimateRecordFromNetSuite(51,{rest}),record);
  assert.deepEqual(calls,[['/record/v1/estimate/51?expandSubResources=true',{method:'GET'}]]);
  for(const id of [0,-1,1.5,'51/!transform/salesOrder',Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(fetchEstimateRecordFromNetSuite(id,{rest}));
  }
  assert.equal(calls.length,1);
});
test('live numeric estimate units resolve to original NetSuite labels without altering quantities or the source record',async()=>{
  const numeric={...record,item:{items:[{...record.item.items[0],units:'246'},
    {...record.item.items[0],units:null},{...record.item.items[0],units:{refName:'Yard'}}]}};
  const calls=[];
  const remote={suiteql:async sql=>{calls.push(sql);return {items:sql.includes('unit_id')
    ? [{unit_id:'246',unit:'EACH'}]:[{id:51,tranid:'ESTB123',location:1}]};},
  fetchEstimateRecordFromNetSuite:async()=>numeric};
  const documents=createDeliveryRequestDocuments({loadNetSuite:async()=>remote});
  const preview=await documents.estimate('ESTB123',1);
  assert.deepEqual(preview.lines.map(line=>line.unit),['EACH','','Yard']);
  assert.deepEqual(preview.lines.map(line=>line.quantity),[2,2,2]);
  assert.equal(numeric.item.items[0].units,'246');
  assert.equal(calls.length,2);
  assert.match(calls[1],/SELECT DISTINCT tl.units AS unit_id, BUILTIN.DF\(tl.units\) AS unit/);
  assert.match(calls[1],/tl.transaction=51 AND tl.units IS NOT NULL/);
  for(const units of [[],[{unit_id:'246',unit:''}]]) {
    remote.suiteql=async sql=>({items:sql.includes('unit_id')?units:[{id:51,tranid:'ESTB123',location:1}]});
    await assert.rejects(documents.estimate('ESTB123',1),{code:'DELIVERY_DOCUMENT_UNAVAILABLE',status:502});
  }
});
