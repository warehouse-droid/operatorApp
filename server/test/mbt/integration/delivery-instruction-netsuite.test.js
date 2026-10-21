import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {randomInt,randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {readDeliveryNetSuite,updateDeliveryNetSuite} from '../../../src/delivery-instruction-netsuite.js';
import {getDeliveryInstruction,getDeliveryInstructionNetSuite,saveDeliveryInstructionNetSuite} from '../../../src/delivery-instruction-repository.js';
after(closeDb);
async function fixture(){
 const id=9_750_000_000+randomInt(100000000),ref='DI-NS-'+randomUUID().slice(0,8);
 await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,order_location_id,sales_order_type,memo,netsuite_active,synced_at,dispatch_address,dispatch_window_start,dispatch_instruction_details,dispatch_instruction_parse_version)
 VALUES($1,$2,current_date,'Test customer','Pending Fulfillment','Pending Fulfillment',1,'Delivery','Old memo',true,now(),'Keep planned address','09:00','{"text":"Old parsed","phones":[]}',2)`,[id,ref]);
 const record={id:String(id),tranId:ref,location:{id:'1'},custbody3:{id:'2'},status:{id:'B'},custbody7:'Old memo',shipDate:'2026-10-01',custbody4:'2026-10-02'};
 const calls=[],context={source:'sales',authorizedOrderingLocationIds:[1]},rest=async(path,options={})=>{
  assert.equal(path,`/record/v1/salesOrder/${id}`);calls.push(options);
  if(options.method==='PATCH')Object.assign(record,options.body);return{data:structuredClone(record)};
 };
 const transport={rest},remote={read:orderId=>readDeliveryNetSuite(orderId,transport),update:input=>updateDeliveryNetSuite(input,transport)};
 return{id,ref,record,calls,context,remote};
}
const target={memo:'Delivery Address: leave planned address alone\nTel: 416-555-1234\nUse the new gate.',shipDate:'2026-11-01',deliverByDate:'2026-11-02'};
test('verified NetSuite edit refreshes local memo, date and driver preview while retaining app text and plan',async()=>{
 const f=await fixture();
 await query("INSERT INTO sales_order_delivery_instructions(sales_order_id,additional_text,revision)VALUES($1,'Keep app text',1)",[f.id]);
 const expected=await getDeliveryInstructionNetSuite(f.id,f.context,f.remote);
 assert.equal(expected.orderId,f.id);assert.equal(expected.revision,1);assert.equal(expected.netSuite.values.memo,'Old memo');
 const saved=await saveDeliveryInstructionNetSuite(f.id,{expectedRevision:1,expected:expected.netSuite,values:target},f.context,f.remote);
 assert.equal(saved.revision,2);assert.deepEqual(saved.netSuite.values,target);assert.equal(saved.additionalText,'Keep app text');
 assert.match(saved.automatic.text,/Use the new gate/);assert.doesNotMatch(saved.automatic.text,/Delivery Address/);
 assert.equal(saved.automatic.phones[0].href,'+14165551234');
 const row=(await query('SELECT memo,expected_delivery_date::text,dispatch_address,dispatch_window_start::text FROM sales_orders WHERE netsuite_id=$1',[f.id])).rows[0];
 assert.equal(row.memo,target.memo);assert.equal(row.expected_delivery_date,target.deliverByDate);assert.equal(row.dispatch_address,'Keep planned address');assert.equal(row.dispatch_window_start,'09:00');
});
test('concurrent saves and stale revisions cannot issue a second remote mutation',async()=>{
 const f=await fixture(),expected=await getDeliveryInstructionNetSuite(f.id,f.context,f.remote);
 const input={expectedRevision:0,expected:expected.netSuite,values:target};
 const results=await Promise.allSettled([saveDeliveryInstructionNetSuite(f.id,input,f.context,f.remote),saveDeliveryInstructionNetSuite(f.id,input,f.context,f.remote)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
});
test('scope, remote yard and completed order checks prevent reads and writes before NetSuite mutation',async()=>{
 const f=await fixture();
 for(const context of [{source:'sales',authorizedOrderingLocationIds:[28]},{source:'dispatch',authorizedOrderingLocationIds:[1]},{source:'sales'}]){
  await assert.rejects(()=>getDeliveryInstructionNetSuite(f.id,context,f.remote),e=>e.status===403);
 }
 assert.equal(f.calls.length,0);
 const expected=await getDeliveryInstructionNetSuite(f.id,f.context,f.remote);
 f.record.location.id='28';
 await assert.rejects(()=>getDeliveryInstructionNetSuite(f.id,f.context,f.remote),e=>e.status===409&&/identity or yard changed/.test(e.message));
 await assert.rejects(()=>saveDeliveryInstructionNetSuite(f.id,{expectedRevision:0,expected:expected.netSuite,values:target},f.context,f.remote),e=>e.status===409||e.status===403);
 assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);
 f.record.location.id='1';
 await query("UPDATE sales_orders SET status_text='Closed',status='Closed' WHERE netsuite_id=$1",[f.id]);
 await assert.rejects(()=>saveDeliveryInstructionNetSuite(f.id,{expectedRevision:0,expected:expected.netSuite,values:target},f.context,f.remote),e=>[404,409].includes(e.status));
});
test('failed or uncertain remote save leaves local fields and revision unchanged and can be retried',async()=>{
 const f=await fixture(),expected=await getDeliveryInstructionNetSuite(f.id,f.context,f.remote),input={expectedRevision:0,expected:expected.netSuite,values:target};
 await assert.rejects(()=>saveDeliveryInstructionNetSuite(f.id,input,f.context,{...f.remote,update:async()=>{throw Error('unverified');}}),/unverified/);
 const unchanged=await getDeliveryInstruction(f.id,f.context);assert.equal(unchanged.revision,0);assert.equal(unchanged.automatic.text,'Old parsed');
 // NetSuite committed but the previous HTTP/readback was lost.
 Object.assign(f.record,{custbody7:target.memo,shipDate:target.shipDate,custbody4:target.deliverByDate});
 const saved=await saveDeliveryInstructionNetSuite(f.id,input,f.context,f.remote);
 assert.equal(saved.revision,1);assert.deepEqual(saved.netSuite.values,target);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);
});

test('malformed snapshot cannot bypass identity validation or produce an internal error',async()=>{
 const f=await fixture(),loaded=await getDeliveryInstructionNetSuite(f.id,f.context,f.remote);
 await assert.rejects(()=>saveDeliveryInstructionNetSuite(f.id,{expectedRevision:0,expected:{values:loaded.netSuite.values},values:target},f.context,f.remote),e=>e.status===400);
 assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);
});
test('completed dropoff prevents NetSuite edits and returns the retained order as read-only',async()=>{
 const f=await fixture(),loaded=await getDeliveryInstructionNetSuite(f.id,f.context,f.remote);
 await query("INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status,completed_at)VALUES($1,'driver-test','dropoff',$2::jsonb,'complete',now())",['di-ns-'+f.id,JSON.stringify([f.ref])]);
 const retained=await getDeliveryInstructionNetSuite(f.id,f.context,f.remote);assert.equal(retained.editable,false);
 await assert.rejects(()=>saveDeliveryInstructionNetSuite(f.id,{expectedRevision:0,expected:loaded.netSuite,values:target},f.context,f.remote),e=>e.status===409);
 assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);
});
