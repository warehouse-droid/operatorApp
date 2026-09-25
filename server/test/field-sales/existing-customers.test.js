import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fc from 'fast-check';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {customerFixture} from './customer-fixture.js';
import {createOrderPublisher} from '../../src/field-sales/orders.js';
after(closeDb);
beforeEach(()=>query("UPDATE field_sales_order_jobs SET state='attention' WHERE state IN ('pending','working','uncertain')"));
const acceptance=f=>({id:f.draft.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-22T03:00:00Z'});
async function mirror(id='987000001',{active=true,currency='CAD'}={}){
 await query(`INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1::bigint,$1::text,'Existing customer','Existing customer',$2,$3,now(),'test',repeat('a',64)) ON CONFLICT(netsuite_id) DO UPDATE SET active=$3,currency=$2`,[id,currency,active]);return id;
}
async function linkedFixture(){const f=await customerFixture({linked:false});const id=await mirror();f.customer=(await f.cmd('customer.save',{...f.customer,netsuiteCustomers:{MBBS:id}})).customer;return f;}

test('Unlinked local customers can save quotes without billing, but confirmation is atomic and requires NetSuite links',()=>withTransaction(async()=>{
 const f=await customerFixture({linked:false});f.customer=(await f.cmd('customer.save',{...f.customer,billing:{}})).customer;
 const q=(await f.cmd('quote.save',f.draft)).quote;assert.equal(q.snapshot.totalMinor,545643);
 await assert.rejects(f.cmd('quote.confirm',acceptance(f)),/link.*existing.*NetSuite customer/i);
 assert.equal((await f.repo.getQuote(q.id)).confirmation,null);
 assert.equal((await query('SELECT count(*)::int n FROM field_sales_order_jobs WHERE quote_id=$1',[q.id])).rows[0].n,0);
},{rollback:true}));

test('Confirmation atomically saves selected existing accounts without customer creation configuration or billing',()=>withTransaction(async()=>{
 const f=await customerFixture({linked:false}),id=await mirror(),settings=await f.repo.settings();
 for(const c of Object.values(settings.data.companies)){delete c.customerFormId;delete c.customerStatusId;}
 await f.repo.saveSettings(f.admin,settings);f.customer=(await f.cmd('customer.save',{...f.customer,billing:{}})).customer;
 await f.cmd('quote.save',f.draft);
 await f.cmd('quote.confirm',{...acceptance(f),customerRevision:f.customer.revision,netsuiteCustomers:{MBBS:id}});
 const q=await f.repo.getQuote(f.draft.id),job=(await query('SELECT payload FROM field_sales_order_jobs WHERE quote_id=$1',[q.id])).rows[0];
 assert.equal(q.confirmation.confirmedBy,'Lee');assert.equal(job.payload.linkedCustomerId,id);
 assert.equal(job.payload.config.customerFormId,undefined);assert.equal(job.payload.config.customerStatusId,undefined);
 assert.equal((await f.repo.getCustomer(f.customer.id)).netsuiteCustomers.MBBS,id);
 assert.equal((await f.repo.getQuote(q.id,1)).snapshot.customer.netsuiteCustomers.MBBS,undefined);
},{rollback:true}));

test('Invalid or stale confirmation customer choices never persist partial mappings or orders',()=>withTransaction(async()=>{
 const f=await customerFixture({linked:false}),id=await mirror();await mirror('987000002',{active:false});await mirror('987000003',{currency:'USD'});
 f.draft={...f.draft,schemaVersion:3,company:null,lines:['MBBS','MBT','MBR'].flatMap(company=>f.draft.lines.map(l=>({...l,id:randomUUID(),company})))};await f.cmd('quote.save',f.draft);
 for(const patch of [{netsuiteCustomers:{MBBS:id}},{netsuiteCustomers:{MBBS:id,MBT_MBR:'987000002'}},{netsuiteCustomers:{MBBS:id,MBT_MBR:'987000003'}},{netsuiteCustomers:{MBBS:id,MBT_MBR:'1;DROP TABLE'}},{netsuiteCustomers:{MBBS:id,MBT_MBR:'999999999'}},{netsuiteCustomers:{MBBS:id,MBT_MBR:id},customerRevision:0},{netsuiteCustomers:{MBBS:id,MBT_MBR:id,OTHER:id}},{netsuiteCustomers:null}]){
  await assert.rejects(f.cmd('quote.confirm',{...acceptance(f),customerRevision:f.customer.revision,...patch}),e=>[400,409].includes(e.status));
  assert.equal((await f.repo.getQuote(f.draft.id)).confirmation,null);assert.deepEqual((await f.repo.getCustomer(f.customer.id)).netsuiteCustomers,{});
  assert.equal((await query('SELECT count(*)::int n FROM field_sales_order_jobs WHERE quote_id=$1',[f.draft.id])).rows[0].n,0);
 }
},{rollback:true}));

test('Legacy queued jobs without an explicit accepted link cannot create an order, even with a persisted customer ID',async()=>{
 for(const persisted of [null,'987000001']){
  const f=await linkedFixture();await f.cmd('quote.save',f.draft);await f.cmd('quote.confirm',acceptance(f));
  await query("UPDATE field_sales_order_jobs SET payload=jsonb_set(payload,'{linkedCustomerId}','null'),customer_netsuite_id=$2 WHERE quote_id=$1",[f.draft.id,persisted]);
  const calls=[],transport=async(action,p)=>{calls.push(action);if(action==='order.lookup'){return {found:false};}if(action==='customer.lookup'){return {found:true,internalId:'987000001',externalId:p.customerExternalId,active:true,currencyId:'1',subsidiaries:['1']};}return {ok:true};};
  await createOrderPublisher(f.repo,{enabled:true,transport}).tick();const q=await f.repo.getQuote(f.draft.id);
  assert.equal(q.order.state,'attention');assert.match(q.order.error,/existing.*NetSuite customer|customer link/i);
  assert.ok(!calls.includes('customer.ensure'));assert.ok(!calls.includes('order.create'));
 }
});

test('Customer lookup failure never attempts customer creation or subsidiary changes',async()=>{
 for(const remote of [{found:false},{found:true,internalId:'987000001',active:true,currencyId:'1',subsidiaries:[]}]){
  const f=await linkedFixture();await f.cmd('quote.save',f.draft);await f.cmd('quote.confirm',acceptance(f));
  const calls=[],transport=async(action)=>{calls.push(action);return action==='customer.lookup'?remote:{found:false,ok:true};};
  await createOrderPublisher(f.repo,{enabled:true,transport}).tick();const q=await f.repo.getQuote(f.draft.id);
  assert.equal(q.order.state,'attention');assert.match(q.order.error,/NetSuite|subsidiar/i);
  assert.ok(!calls.includes('customer.ensure'));assert.ok(!calls.includes('order.create'));
 }
});

test('Customer group property: exactly the represented accounts are required and all order identities are explicit',()=>withTransaction(async()=>{
 const mbbs=await mirror(),shared=await mirror('987000004');
 await fc.assert(fc.asyncProperty(fc.subarray(['MBBS','MBT','MBR'],{minLength:1}),async companies=>{
  const f=await customerFixture({linked:false});f.draft={...f.draft,schemaVersion:3,company:null,lines:companies.map(company=>({...f.draft.lines[0],id:randomUUID(),company}))};
  await f.cmd('quote.save',f.draft);
  const mappings={...(companies.includes('MBBS')?{MBBS:mbbs}:{}),...(companies.some(c=>c!=='MBBS')?{MBT_MBR:shared}:{})};
  for(const missing of Object.keys(mappings)){
   const incomplete={...mappings};delete incomplete[missing];
   await assert.rejects(f.cmd('quote.confirm',{...acceptance(f),customerRevision:f.customer.revision,netsuiteCustomers:incomplete}),/Link an existing/);
   assert.equal((await f.repo.getQuote(f.draft.id)).confirmation,null);assert.deepEqual((await f.repo.getCustomer(f.customer.id)).netsuiteCustomers,{});
  }
  await f.cmd('quote.confirm',{...acceptance(f),customerRevision:f.customer.revision,netsuiteCustomers:mappings});
  const jobs=(await query('SELECT payload FROM field_sales_order_jobs WHERE quote_id=$1',[f.draft.id])).rows;
  assert.equal(jobs.length,companies.length);
  for(const {payload:p}of jobs){assert.equal(p.linkedCustomerId,p.company==='MBBS'?mbbs:shared);assert.equal(p.config.customerFormId,undefined);assert.equal(p.config.customerStatusId,undefined);}
  assert.deepEqual((await f.repo.getCustomer(f.customer.id)).netsuiteCustomers,mappings);
 }),{numRuns:20,seed:20260922});
},{rollback:true}));

test('Oversized NetSuite IDs are rejected as validation errors with no partial acceptance',()=>withTransaction(async()=>{
 const f=await customerFixture({linked:false});await f.cmd('quote.save',f.draft);
 await assert.rejects(f.cmd('quote.confirm',{...acceptance(f),customerRevision:f.customer.revision,netsuiteCustomers:{MBBS:'9'.repeat(40)}}),e=>e.status===400);
 assert.equal((await f.repo.getQuote(f.draft.id)).confirmation,null);
},{rollback:true}));

test('Concurrent customer editing and confirmation cannot overwrite a reviewed mapping',async()=>{
 const f=await customerFixture({linked:false}),first=await mirror(),second=await mirror('987000004');await f.cmd('quote.save',f.draft);
 const results=await Promise.allSettled([
  f.cmd('customer.save',{...f.customer,netsuiteCustomers:{MBBS:second}}),
  f.cmd('quote.confirm',{...acceptance(f),customerRevision:f.customer.revision,netsuiteCustomers:{MBBS:first}})
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 const q=await f.repo.getQuote(f.draft.id),c=await f.repo.getCustomer(f.customer.id);
 if(q.confirmation){assert.equal(c.netsuiteCustomers.MBBS,first);assert.equal(q.orders.length,1);}
 else{assert.equal(c.netsuiteCustomers.MBBS,second);assert.equal(q.orders.length,0);}
});

test('A persisted worker customer cannot replace the accepted customer identity',async()=>{
 const f=await linkedFixture();await f.cmd('quote.save',f.draft);await f.cmd('quote.confirm',acceptance(f));
 await query('UPDATE field_sales_order_jobs SET customer_netsuite_id=$2 WHERE quote_id=$1',[f.draft.id,'987000004']);
 const calls=[];await createOrderPublisher(f.repo,{enabled:true,transport:async action=>{calls.push(action);return {found:false};}}).tick();
 const q=await f.repo.getQuote(f.draft.id);assert.equal(q.order.state,'attention');assert.match(q.order.error,/accepted customer link/);assert.deepEqual(calls,[]);
});

test('Malformed account choices are rejected before any acceptance',()=>withTransaction(async()=>{
 const f=await customerFixture({linked:false}),id=await mirror();await f.cmd('quote.save',f.draft);
 for(const choices of [[], 'invalid']){await assert.rejects(f.cmd('quote.confirm',{...acceptance(f),customerRevision:f.customer.revision,netsuiteCustomers:choices}),e=>e.status===400);}
 await assert.rejects(f.cmd('quote.confirm',{...acceptance(f),netsuiteCustomers:{MBBS:id}}),e=>e.status===409);
},{rollback:true}));
