import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createOrderPublisher} from '../../src/field-sales/orders.js';
import {customerFixture,fakeNetSuite} from './customer-fixture.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable test database required.');}
test('T3 three company quotes have independent numbers, confirmations and orders with two customer mappings',()=>withTransaction(async()=>{
 await query("UPDATE field_sales_order_jobs SET state='attention' WHERE state IN ('pending','working','uncertain')");
 const f=await customerFixture(),remote=fakeNetSuite(),worker=createOrderPublisher(f.repo,{transport:remote.transport,enabled:true}),quotes=[];
 for(const company of ['MBBS','MBT','MBR']){
  const draft={...f.draft,id:randomUUID(),company,lines:f.draft.lines.map(l=>({...l,company}))};
  quotes.push((await f.cmd('quote.save',draft)).quote);
 }
 assert.equal(new Set(quotes.map(q=>q.number)).size,3);
 for(const q of quotes){
  assert.equal(q.snapshot.totalMinor,545643);assert.equal(q.confirmation,null);
  await f.cmd('quote.confirm',{id:q.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z'});await worker.tick();
 }
 const stored=await Promise.all(quotes.map(q=>f.repo.getQuote(q.id)));
 assert.ok(stored.every(q=>q.order.state==='done'));assert.equal(new Set(stored.map(q=>q.order.netsuite_id)).size,3);
 assert.notEqual(stored[0].order.customer_netsuite_id,stored[1].order.customer_netsuite_id);
 assert.equal(stored[1].order.customer_netsuite_id,stored[2].order.customer_netsuite_id);
 assert.equal(remote.customers.size,2);assert.equal(remote.orders.size,3);
 for(const q of stored){await assert.rejects(f.cmd('quote.publish',{id:q.id,revision:1}),/Sales Order|local/);}
},{rollback:true}));
