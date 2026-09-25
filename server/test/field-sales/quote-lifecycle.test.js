import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createOrderPublisher} from '../../src/field-sales/orders.js';
import {customerFixture,fakeNetSuite} from './customer-fixture.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable test database required.');}
test('Q6 accepted quote is immutable; copying creates a separately numbered editable quote and preserves its original order',()=>withTransaction(async()=>{
 await query("UPDATE field_sales_order_jobs SET state='attention' WHERE state IN ('pending','working','uncertain')");
 const f=await customerFixture(),remote=fakeNetSuite(),worker=createOrderPublisher(f.repo,{transport:remote.transport,enabled:true});
 await f.cmd('quote.save',f.draft);
 await f.cmd('quote.save',{...f.draft,revision:1,note:'Final confirmed scope'});
 await f.cmd('quote.confirm',{id:f.draft.id,revision:2,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z'});await worker.tick();
 const accepted=await f.repo.getQuote(f.draft.id);assert.equal(accepted.order.state,'done');assert.equal(accepted.snapshot.totalMinor,545643);
 await assert.rejects(f.cmd('quote.save',{...f.draft,revision:2,note:'Change accepted order'}),/confirmed/);
 const copy=(await f.cmd('quote.copy',{id:accepted.id,newId:randomUUID()})).quote;
 assert.notEqual(copy.number,accepted.number);assert.equal(copy.confirmation,null);assert.equal(copy.order,null);
 await f.cmd('quote.save',{...copy.snapshot,id:copy.id,jobsiteId:copy.jobsite_id,revision:1,note:'New scope',lines:[{...f.draft.lines[0],quantity:'1'}]});
 assert.equal((await f.repo.getQuote(copy.id)).snapshot.totalMinor,4180);
 assert.equal((await f.repo.getQuote(accepted.id,1)).snapshot.note,f.draft.note);
 assert.equal((await f.repo.getQuote(accepted.id)).snapshot.note,'Final confirmed scope');
 assert.equal((await f.repo.getQuote(accepted.id)).order.netsuite_id,accepted.order.netsuite_id);assert.equal(remote.orders.size,1);
 assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_posting_jobs WHERE quote_id=$1',[accepted.id])).rows[0].n,0);
},{rollback:true}));
