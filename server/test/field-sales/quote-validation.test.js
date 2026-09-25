import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query,withTransaction,closeDb } from '../../src/db.js';
import { createFieldSalesRepository } from '../../src/field-sales/repository.js';
import {torontoDate} from '../../public/field-sales/domain.js';
import fc from 'fast-check';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
async function fixture() {
  const actor={id:randomUUID(),role:'admin'},customer='983000001';
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,$1,'test','test','admin',ARRAY['admin'])`,[actor.id]);
  const companies={MBBS:{taxBps:1300,subsidiaryId:'1',salesOrderFormId:'3',locationId:'1',currencyId:'1',taxCodeId:'4'},MBT:{taxBps:1300}};
  await query(`UPDATE field_sales_settings SET data=data||$1::jsonb`,[JSON.stringify({enabled:true,salesOrderPostingEnabled:true,companies})]);
  await query(`INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,source_modified_at,source_version,payload_hash) VALUES($1,'FS-VALIDATION','Builder','Builder','CAD',now(),'test',repeat('b',64)) ON CONFLICT DO NOTHING`,[customer]);
  await query(`INSERT INTO netsuite_customer_subsidiaries(customer_netsuite_id,subsidiary_netsuite_id,source_modified_at,source_version,payload_hash) VALUES($1,1,now(),'test',repeat('b',64)) ON CONFLICT DO NOTHING`,[customer]);
  await query(`INSERT INTO field_sales_catalog(company,item_id,sku,description,unit_rate) VALUES('MBBS','983000001','Block','Block','1') ON CONFLICT DO NOTHING`);
  const repo=createFieldSalesRepository(undefined,{postingEnabled:true,transport:async()=>({found:false})});
  const cmd=(kind,payload)=>repo.command(actor,{id:randomUUID(),kind,payload});
  const site=(await cmd('jobsite.save',{id:randomUUID(),address:'1 Validation Road'})).jobsite;
  const local=(await cmd('customer.save',{id:randomUUID(),name:'Builder',netsuiteCustomers:{MBBS:customer},billing:{line1:'1 Validation Road',city:'Toronto',country:'CA'}})).customer;
  await cmd('customer.link',{customerId:local.id,jobsiteId:site.id});
  const base={id:randomUUID(),company:'MBBS',jobsiteId:site.id,fieldSalesCustomerId:local.id,validUntil:'2026-10-18',lines:[{id:'a',company:'MBBS',itemId:'983000001',description:'Block',quantity:'1',unitRate:'1'}]};
  return {actor,repo,cmd,base,companies};
}
test('Q9 draft validation preserves agreed prices, rejects stale tax policies and customer identities',()=>withTransaction(async()=>{
  const {repo,cmd,base}=await fixture();
  for(const patch of [{fieldSalesCustomerId:'1; DROP TABLE'}, {expectedTaxBps:{MBBS:1400}}, {lines:[{...base.lines[0],itemId:'missing'}]}, {lines:[{...base.lines[0],unitRate:''}]}, {lines:[{...base.lines[0],unitRate:'-2'}]}]){await assert.rejects(cmd('quote.save',{...base,...patch}),e=>[400,409].includes(e.status));}
  // Dates now come from today and Settings, including for older queued forms.
  const result=await cmd('quote.save',{...base,quoteDate:'not-a-date',validUntil:'2026-02-30',lines:[{...base.lines[0],unitRate:'2'}]});assert.equal(result.quote.snapshot.totalMinor,226);assert.equal(result.quote.snapshot.lines[0].catalogPrice.unitRate,'1');assert.equal(result.quote.snapshot.note,'');
  assert.equal(result.quote.snapshot.quoteDate,torontoDate());assert.equal((Date.parse(result.quote.snapshot.validUntil)-Date.parse(result.quote.snapshot.quoteDate))/86400000,30);
  await assert.rejects(cmd('quote.save',{...base,revision:0}),e=>e.status===409);
  await assert.rejects(repo.getQuote(randomUUID()),e=>e.status===404);
},{rollback:true}));
test('Q10 every Sales Order gate fails before creating an outbox row',()=>withTransaction(async()=>{
  const {actor,repo,cmd,base,companies}=await fixture();
  const acceptance={id:base.id,revision:1,confirmedBy:'Builder',confirmedAt:'2026-09-21T19:00:00Z'};
  await assert.rejects(cmd('quote.confirm',{...acceptance,id:randomUUID()}),e=>e.status===404);
  await cmd('quote.save',base);
  await assert.rejects(cmd('quote.confirm',{...acceptance,revision:2}),e=>e.status===409);
  const disabled=createFieldSalesRepository();await assert.rejects(disabled.command(actor,{id:randomUUID(),kind:'quote.confirm',payload:acceptance}),/not enabled/);
  for(const profile of [{...companies.MBBS,taxBps:1400},{...companies.MBBS,salesOrderFormId:''},{...companies.MBBS,currencyId:''}]){
    await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{companies,MBBS}',$1)`,[JSON.stringify(profile)]);
    await assert.rejects(cmd('quote.confirm',acceptance),e=>[400,409].includes(e.status));
    assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_order_jobs WHERE quote_id=$1',[base.id])).rows[0].n,0);
  }
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{companies,MBBS}',$1)`,[JSON.stringify(companies.MBBS)]);
  await cmd('quote.confirm',acceptance);await cmd('quote.confirm',acceptance);
  assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_order_jobs WHERE quote_id=$1',[base.id])).rows[0].n,1);
  assert.equal((await repo.getQuote(base.id)).order.state,'pending');
  await assert.rejects(cmd('quote.save',{...base,revision:1}),/confirmed/);
  await assert.rejects(cmd('quote.order.retry',{id:base.id,revision:2}),/current|changed|latest/i);
  await query(`UPDATE field_sales_order_jobs SET state='attention' WHERE quote_id=$1`,[base.id]);
  await cmd('quote.order.retry',{id:base.id,revision:1});assert.equal((await repo.getQuote(base.id)).order.state,'uncertain');
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{salesOrderPostingEnabled}','false')`);
  await assert.rejects(cmd('quote.order.retry',{id:base.id,revision:1}),/disabled|not enabled/);
},{rollback:true}));
test('Q11 empty drafts cannot be accepted; company changes require separate quotes',()=>withTransaction(async()=>{
  const {cmd,base}=await fixture();
  await cmd('quote.save',{...base,lines:[]});await assert.rejects(cmd('quote.confirm',{id:base.id,revision:1,confirmedBy:'Builder',confirmedAt:'2026-09-21T19:00:00Z'}),/at least one item/);
  await cmd('quote.save',{...base,revision:1});
  await assert.rejects(cmd('quote.save',{...base,company:'MBT',revision:2,lines:[]}),/one company/);
  await assert.rejects(cmd('quote.publish',{id:base.id,revision:2}),/local|Sales Order/);
},{rollback:true}));
test('M1 property quote memos and entered prices round-trip without per-item reasons',()=>withTransaction(async()=>{
  const {cmd,base,repo}=await fixture();
  await fc.assert(fc.asyncProperty(fc.string({maxLength:150}),fc.integer({min:0,max:20000}),fc.integer({min:1,max:40}),async(note,rateMinor,quantity)=>{
    const id=randomUUID(),unitRate=(rateMinor/100).toFixed(2);
    await cmd('quote.save',{...base,id,note,lines:[{...base.lines[0],quantity:String(quantity),unitRate}]});
    const saved=(await repo.getQuote(id)).snapshot,subtotal=BigInt(rateMinor)*BigInt(quantity);
    assert.equal(saved.note,note.trim());assert.equal(saved.lines[0].unitRate,unitRate);
    assert.equal(saved.totalMinor,Number(subtotal+(subtotal*13n+50n)/100n));assert.equal(saved.lines[0].catalogPrice.unitRate,'1');
  }),{numRuns:30,seed:20260919});
},{rollback:true}));
test('M2 memo revisions retain prior text and carry the current memo into each posting payload',()=>withTransaction(async()=>{
  const {cmd,base,repo}=await fixture(),first='Existing customer scope',note='Quote memo: builder’s delivery <notes> & access instructions.';
  await cmd('quote.save',{...base,note:first});
  await cmd('quote.save',{...base,revision:1,note,lines:[{...base.lines[0],unitRate:'2'}]});
  assert.equal((await repo.getQuote(base.id,1)).snapshot.note,first);assert.equal((await repo.getQuote(base.id)).snapshot.note,note);
  await cmd('quote.confirm',{id:base.id,revision:2,confirmedBy:'Builder',confirmedAt:'2026-09-21T19:00:00Z'});
  const jobs=(await query('SELECT payload FROM field_sales_order_jobs WHERE quote_id=$1',[base.id])).rows;
  assert.equal(jobs.length,1);assert.equal(jobs[0].payload.note,note);assert.equal(jobs[0].payload.lines[0].unitRate,'2');
  const long=(await cmd('quote.save',{...base,id:randomUUID(),note:'m'.repeat(10001)})).quote;
  assert.equal(long.snapshot.note.length,10000);
},{rollback:true}));
