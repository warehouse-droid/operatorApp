import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query,withTransaction,closeDb } from '../../src/db.js';
import {customerFixture,fakeNetSuite} from './customer-fixture.js';
import { createOrderPublisher } from '../../src/field-sales/orders.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
// Test runs may deliberately leave an unacknowledged job; isolate each worker case.
beforeEach(()=>query("UPDATE field_sales_order_jobs SET state='attention' WHERE state IN ('pending','working','uncertain')"));

test('Directory supports many-to-many sites, multiple representatives, archive and stale revisions',()=>withTransaction(async()=>{
 const f=await customerFixture(),{repo,cmd,customer,sites}=f;
 assert.equal((await repo.getCustomer(customer.id)).jobsites.length,2);
 const other=(await cmd('customer.save',{id:randomUUID(),name:'Another contractor',representatives:[],typeIds:[]})).customer;
 await cmd('customer.link',{customerId:other.id,jobsiteId:sites[0].id,linked:true});
 assert.equal((await repo.getJobsite(sites[0].id)).customers.length,2);
 await assert.rejects(cmd('customer.save',{...customer,revision:0,name:'stale'}),e=>e.status===409);
 await cmd('customer.save',{...customer,archived:true});
 assert.ok(!(await repo.listCustomers({})).items.some(c=>c.id===customer.id));
 assert.equal((await repo.getCustomer(customer.id)).representatives.length,2);
 await assert.rejects(cmd('quote.save',f.draft),/archived/i);
},{rollback:true}));

test('Visit stores selected customer and representative snapshots and validates ownership',()=>withTransaction(async()=>{
 const {cmd,repo,sites,customer}=await customerFixture();
 const input={id:randomUUID(),jobsiteId:sites[0].id,outcome:'Quote requested',occurredAt:'2026-09-21T18:00:00Z',contacts:[{customerId:customer.id,representativeIds:[customer.representatives[0].id]}]};
 await cmd('visit.record',input);
 await cmd('customer.save',{...customer,name:'Renamed customer'});
 const visit=(await repo.getJobsite(sites[0].id)).visits[0];
 assert.equal(visit.data.contacts[0].name,'Example Builder');
 assert.equal(visit.data.contacts[0].representatives[0].email,'lee@example.test');
 await assert.rejects(cmd('visit.record',{...input,id:randomUUID(),contacts:[{customerId:customer.id,representativeIds:[randomUUID()]}]}),/representative/i);
},{rollback:true}));

test('Company quotes enforce identity and item company and preserve pricing and revision snapshots',()=>withTransaction(async()=>{
 const {cmd,repo,draft,customer}=await customerFixture();
 for(const patch of [{company:''},{lines:[{...draft.lines[0],id:'bad" onclick="alert(1)'}]},{fieldSalesCustomerId:''},{customerRepresentativeId:randomUUID()},{lines:[{...draft.lines[0],company:'MBT'}]}]){await assert.rejects(cmd('quote.save',{...draft,...patch}),e=>[400,409].includes(e.status));}
 const q=(await cmd('quote.save',draft)).quote;
 assert.equal(q.snapshot.totalMinor,545643);assert.equal(q.snapshot.companies.MBBS.taxMinor,62773);
 assert.match(q.number,/^FS-MBBS-/);assert.equal(q.snapshot.customer.name,customer.name);
 await cmd('customer.save',{...customer,name:'New name'});
 await cmd('quote.save',{...draft,revision:1,note:'New memo'});
 assert.equal((await repo.getQuote(q.id,1)).snapshot.customer.name,'Example Builder');
 assert.equal((await repo.getQuote(q.id,1)).snapshot.note,draft.note);
 assert.equal((await repo.getQuote(q.id)).snapshot.customer.name,'New name');
 assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_posting_jobs WHERE quote_id=$1',[q.id])).rows[0].n,0);
 await assert.rejects(cmd('quote.publish',{id:q.id,revision:2}),/Sales Order|local/i);
},{rollback:true}));

test('Confirmation locks the current revision, creates one order intent, and rejects stale or empty acceptance',()=>withTransaction(async()=>{
 const {cmd,repo,draft}=await customerFixture();
 await cmd('quote.save',draft);
 const accept={id:draft.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z',note:'Confirmed by phone'};
 await assert.rejects(cmd('quote.confirm',{...accept,revision:2}),/current|changed/i);
 await assert.rejects(cmd('quote.confirm',{...accept,confirmedBy:''}),/confirmed/i);
 await cmd('quote.confirm',accept);await cmd('quote.confirm',accept);
 const q=await repo.getQuote(draft.id);assert.equal(q.confirmation.confirmedBy,'Lee');assert.equal(q.order.state,'pending');
 assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_order_jobs WHERE quote_id=$1',[draft.id])).rows[0].n,1);
 await assert.rejects(cmd('quote.save',{...draft,revision:1}),/accepted|confirmed/i);
 const copy=(await cmd('quote.copy',{id:draft.id,newId:randomUUID()})).quote;
 assert.notEqual(copy.id,draft.id);assert.equal(copy.confirmation,null);assert.equal(copy.snapshot.note,draft.note);
 await cmd('quote.save',{...copy.snapshot,id:copy.id,jobsiteId:draft.jobsiteId,revision:copy.revision,note:'Editable copy'});
},{rollback:true}));

test('Concurrent MBT/MBR confirmations share one customer but create independent orders',async()=>{
 const f=await customerFixture(),remote=fakeNetSuite(),ids=[];
 for(const company of ['MBT','MBR']){
  const draft={...f.draft,id:randomUUID(),company,lines:f.draft.lines.map(l=>({...l,company}))};ids.push(draft.id);
  await f.cmd('quote.save',draft);await f.cmd('quote.confirm',{id:draft.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z'});
 }
 const first=createOrderPublisher(f.repo,{transport:remote.transport,enabled:true}),second=createOrderPublisher(f.repo,{transport:remote.transport,enabled:true});
 await Promise.all([first.tick(),second.tick()]);
 assert.equal(remote.customers.size,1);assert.equal(remote.orders.size,2);
 for(const id of ids){assert.equal((await f.repo.getQuote(id)).order.state,'done');}
 assert.equal((await f.repo.getCustomer(f.customer.id)).netsuiteCustomers.MBT_MBR,'701');
 assert.equal(remote.calls.filter(c=>c==='customer.ensure').length,0);
});

test('Lost order response resumes by external ID without recreating customer or order',async()=>{
 const f=await customerFixture(),remote=fakeNetSuite({loseOrderResponse:true});
 await f.cmd('quote.save',f.draft);await f.cmd('quote.confirm',{id:f.draft.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z'});
 const worker=createOrderPublisher(f.repo,{transport:remote.transport,enabled:true});await worker.tick();
 assert.equal((await f.repo.getQuote(f.draft.id)).order.state,'uncertain');
 await query('UPDATE field_sales_order_jobs SET next_attempt_at=now() WHERE quote_id=$1',[f.draft.id]);await worker.tick();
 assert.equal((await f.repo.getQuote(f.draft.id)).order.state,'done');assert.equal(remote.customers.size,1);assert.equal(remote.orders.size,1);
 assert.equal(remote.calls.filter(c=>c==='order.create').length,1);
});

test('Remote total mismatch retains the Sales Order ID for attention and never creates a replacement',async()=>{
 const f=await customerFixture(),remote=fakeNetSuite({wrongTotals:true});
 await f.cmd('quote.save',f.draft);await f.cmd('quote.confirm',{id:f.draft.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z'});
 const worker=createOrderPublisher(f.repo,{transport:remote.transport,enabled:true});await worker.tick();
 let q=await f.repo.getQuote(f.draft.id);assert.equal(q.order.state,'attention');assert.equal(q.order.netsuite_id,'900');assert.match(q.order.error,/total/i);
 await f.cmd('quote.order.retry',{id:q.id,revision:1});await worker.tick();q=await f.repo.getQuote(q.id);
 assert.equal(q.order.state,'attention');assert.equal(remote.orders.size,1);
});

test('Archived customer types retain existing links while blocking new assignments',()=>withTransaction(async()=>{
 const f=await customerFixture();await f.cmd('customerType.save',{...f.type,archived:true});
 const revised=(await f.cmd('customer.save',{...f.customer,note:'Contact updated'})).customer;
 assert.equal(revised.types[0].archived,true);assert.equal(revised.note,'Contact updated');
 await assert.rejects(f.cmd('customer.save',{id:randomUUID(),name:'New builder',typeIds:[f.type.id]}),/active customer type/);
},{rollback:true}));

test('Lost order response can reconcile after catalog preflight becomes unavailable',async()=>{
 const f=await customerFixture(),remote=fakeNetSuite({loseOrderResponse:true});let deny=false;
 const transport=(action,p)=>{if(deny&&action==='order.preflight'){throw new Error('Catalog item was later disabled');}return remote.transport(action,p);};
 await f.cmd('quote.save',f.draft);await f.cmd('quote.confirm',{id:f.draft.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z'});
 const worker=createOrderPublisher(f.repo,{transport,enabled:true});await worker.tick();deny=true;
 await query('UPDATE field_sales_order_jobs SET next_attempt_at=now() WHERE quote_id=$1',[f.draft.id]);await worker.tick();
 assert.equal((await f.repo.getQuote(f.draft.id)).order.state,'done');assert.equal(remote.orders.size,1);
});

test('Explicit NetSuite customer mappings validate identity, reuse accounts and forbid relinking a pending order',()=>withTransaction(async()=>{
 const f=await customerFixture();
 for(const id of ['986000001','986000002']){await query(`INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,source_modified_at,source_version,payload_hash) VALUES($1::bigint,$1::text,'Existing builder','Existing builder','CAD',now(),'test',repeat('a',64)) ON CONFLICT DO NOTHING`,[id]);}
 await assert.rejects(f.cmd('customer.save',{...f.customer,netsuiteCustomers:{MBBS:'invalid'}}),/valid NetSuite/);
 await assert.rejects(f.cmd('customer.save',{...f.customer,netsuiteCustomers:{MBBS:'9999999999'}}),/active CAD/);
 const linked=(await f.cmd('customer.save',{...f.customer,netsuiteCustomers:{MBBS:'986000001'}})).customer;
 assert.equal(linked.netsuiteCustomers.MBBS,'986000001');
 const unchanged=(await f.cmd('customer.save',{...linked,note:'Keep existing link'})).customer;
 assert.equal(unchanged.netsuiteCustomers.MBBS,'986000001');
 await f.cmd('quote.save',f.draft);await f.cmd('quote.confirm',{id:f.draft.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z'});
 const job=(await f.repo.getQuote(f.draft.id)).order;assert.equal((await query('SELECT payload FROM field_sales_order_jobs WHERE id=$1',[job.id])).rows[0].payload.linkedCustomerId,'986000001');
 await assert.rejects(f.cmd('customer.save',{...unchanged,netsuiteCustomers:{MBBS:'986000002'}}),/pending Sales Order/);
 assert.equal((await f.repo.getCustomer(f.customer.id)).netsuiteCustomers.MBBS,'986000001');
},{rollback:true}));
