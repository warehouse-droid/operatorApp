import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectionWor,inspectionSos,completionSos,purchaseBill,workChildren,createRepairNetSuite} from '../../src/repair/netsuite.js';
const mappings={subsidiaryId:'7',locationId:'52',classId:'127',currencyId:'1',sosFormId:'183',billFormId:'137',partsAccountId:'2211',inspectionItemId:'10660',partsItemId:'10555',discountItemId:'10716',taxCodeId:'11'};
const job={id:'abc',number:'REP-0000001',company:'MBT',inspectionFeeMinor:15000,inspectionTaxBps:1300,data:{defect:'Light broken',vehicle:{netsuiteId:'36',customerId:'7973',plate:'CC46868',serial:'VIN',alias:'FLAT#5'}}};
test('inspection creates the existing custom WOR and correct SOS form/fee',()=>{
 const wor=inspectionWor(job,mappings);assert.equal(wor.custrecord_wo_vehicle.id,'36');assert.equal(wor.custrecord_wo_customer.id,'7973');assert.equal(wor.custrecord147,'Light broken');
 const sos=inspectionSos(job,mappings,'405');assert.equal(sos.customForm.id,'183');assert.equal(sos.custbody14.id,'405');assert.equal(sos.item.items[0].rate,150);assert.equal(sos.item.items[0].item.id,'10660');
 assert.throws(()=>inspectionSos({...job,company:'MBR'},mappings,'405'),/internal/i);
});
test('completion SOS contains original inspection and flat credit once',()=>{
 const lines=[{id:'a',kind:'labor',itemId:'10650',quantityMilli:1000,unitMinor:100000,amountMinor:100000,description:'Fix',decision:'approved'},
 {id:'b',kind:'part',itemId:'10555',quantityMilli:1000,unitMinor:9999,amountMinor:9999,description:'Declined',decision:'rejected'}];
 const p=completionSos(job,mappings,'405',lines);
 assert.deepEqual(p.item.items.map(x=>x.rate),[150,-150,1000]);assert.equal(p.item.items[1].item.id,'10716');
 assert.equal(p.item.items.reduce((sum,l)=>sum+(l.quantity??1)*l.rate,0),1000);
});
test('purchase bill uses expense lines and never item receipts or PO transforms',()=>{
 const p=purchaseBill({id:'purchase-a',invoiceRef:'INV-22',vendorId:'12821',purchaseDate:'2026-10-26',lines:[{description:'Pump',quantityMilli:5000,unitMinor:10000,taxBps:1300,accountId:'2211',requestNumber:'REP-1'}]},mappings);
 assert.equal(p.entity.id,'12821');assert.equal(p.tranId,'INV-22');assert.equal(p.expense.items[0].amount,500);assert.equal(p.expense.items[0].account.id,'2211');assert.equal(p.item,undefined);assert.equal(p.createdFrom,undefined);
});
test('WOR labor and parts retain different actual and billable quantities',()=>{
 const rows=workChildren(job,mappings,'405',[{id:'a',kind:'part',itemId:'10555',description:'Pump',quantityMilli:3000,unitMinor:10000,amountMinor:30000,decision:'approved'}],[{partDescription:'Pump',quantityMilli:2000,quoteLineId:'a',kind:'issue'}],[]);
 assert.equal(rows[0].recordType,'customrecord247');assert.equal(rows[0].payload.custrecord162,2);assert.equal(rows[0].payload.custrecord169,3);
});
test('billed SOS is checked before any WOR or child updates',async()=>{
 let writes=0;
 const adapter=createRepairNetSuite({queryAll:async()=>[],record:async(type,id,options)=>{
  if(options.method!=='GET'){writes++;return {status:204};}
  if(type==='salesOrder')return {data:{id:'109',entity:{id:'7973'},orderStatus:{id:'G'},item:{items:[{quantityBilled:1}]}}};
  return {data:{id:'501',externalId:String(id).replace(/^eid:/,''),custrecord_wo_vehicle:{id:'36'}}};
 }});
 await assert.rejects(adapter.complete({...job,data:{...job.data,worId:'405',sosId:'109'}},mappings,[],[],[]),error=>error.code==='REPAIR_ACCOUNTING_RECONCILIATION');
 assert.equal(writes,0,'no partial financial rewrite of billed work');
});
test('existing supplier invoice blocks duplicate Bill creation even with a different external identity',async()=>{
 let writes=0;const adapter=createRepairNetSuite({queryAll:async()=>[{id:'999',externalid:'manual-bill'}],record:async(_type,id,options)=>{if(options.method!=='GET')writes++;return {data:{id:'501',externalId:String(id).replace(/^eid:/,''),tranId:'INV-22'}};}});
 await assert.rejects(adapter.bill({id:'purchase-a',invoiceRef:'INV-22',vendorId:'12821',purchaseDate:'2026-10-26',lines:[{description:'Pump',quantityMilli:1000,unitMinor:10000,taxBps:1300,accountId:'2211'}]},mappings),/existing|already|duplicate/i);assert.equal(writes,0);
});
test('changed WOR equipment or customer stops completion before any external writes',async()=>{
 for(const identity of [{vehicle:'99',customer:'7973'},{vehicle:'36',customer:'999'}]){
  let writes=0;const adapter=createRepairNetSuite({queryAll:async()=>[],record:async(type,id,options)=>{
   if(options.method!=='GET'){writes++;return {status:204};}
   if(type==='customrecord_mbr_work_order')return {data:{id,externalId:`repair-${job.id}-wor`,custrecord_wo_vehicle:{id:identity.vehicle},custrecord_wo_customer:{id:identity.customer}}};
   return {data:{id:'501',externalId:String(id).replace(/^eid:/,'')}};
  }});
  await assert.rejects(adapter.complete({...job,company:'MBR',data:{...job.data,worId:'405'}},mappings,[],[],[]),error=>error.code==='REPAIR_REMOTE_IDENTITY');
  assert.equal(writes,0,'a relinked work order must not be modified');
 }
});
