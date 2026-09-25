import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createFieldSalesRepository} from '../../src/field-sales/repository.js';
import {createSalesCatalog} from '../../src/field-sales/catalog.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
test('T5 server preserves entered prices without per-item reasons and retains catalog provenance',()=>withTransaction(async()=>{
  const actor={id:randomUUID(),role:'admin'};await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,$1,'test','test','admin',ARRAY['admin'])`,[actor.id]);
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{enabled}','true')`);
  const pricing={priceLevel:'TRADE',unitId:'1',tiers:[{minimumQuantity:'0',unitRate:'50'},{minimumQuantity:'7',unitRate:'40'}]};
  await query(`INSERT INTO field_sales_catalog(company,item_id,sku,description,unit,unit_rate,pricing) VALUES('MBR','985000001','Rental','Rental','Day','50',$1)`,[JSON.stringify(pricing)]);
  const repo=createFieldSalesRepository(),cmd=(kind,payload)=>repo.command(actor,{id:randomUUID(),kind,payload});
  const site=(await cmd('jobsite.save',{id:randomUUID(),address:'7 Rental Road'})).jobsite;
  const customer=(await cmd('customer.save',{id:randomUUID(),name:'Rental Builder'})).customer;
  await cmd('customer.link',{customerId:customer.id,jobsiteId:site.id});
  const input={id:randomUUID(),company:'MBR',jobsiteId:site.id,fieldSalesCustomerId:customer.id,lines:[{id:'rental',company:'MBR',itemId:'985000001',description:'Rental',quantity:'7',unitRate:'40'}]};
  const q=(await cmd('quote.save',input)).quote;assert.equal(q.snapshot.totalMinor,31640);assert.equal(q.snapshot.lines[0].catalogPrice.unitRate,'40');assert.deepEqual(q.snapshot.lines[0].catalogPrice.pricing,pricing);
  const agreed=(await cmd('quote.save',{...input,revision:1,lines:[{...input.lines[0],unitRate:'50'}]})).quote;
  assert.equal(agreed.snapshot.totalMinor,39550);assert.equal(agreed.snapshot.lines[0].unitRate,'50');assert.equal(agreed.snapshot.lines[0].catalogPrice.unitRate,'40');
  await query(`UPDATE field_sales_catalog SET unit_rate=NULL,pricing=jsonb_set(pricing,'{tiers}','[]') WHERE company='MBR' AND item_id='985000001'`);
  await assert.rejects(cmd('quote.save',{...input,revision:2,lines:[{...input.lines[0],unitRate:''}]}),/decimal/);
  const next=(await cmd('quote.save',{...input,revision:2,note:'Agreed weekly rental'})).quote;
  assert.equal(next.snapshot.note,'Agreed weekly rental');assert.equal(next.revision,3);
  assert.equal(next.snapshot.totalMinor,31640);assert.equal(next.snapshot.lines[0].catalogPrice.unitRate,null);assert.equal((await repo.getQuote(input.id,1)).snapshot.lines[0].catalogPrice.unitRate,'40');
},{rollback:true}));
test('T6 Trade migration rollback retains settings, catalog and immutable revisions',async()=>{
  const read=async()=>(await query(`SELECT (SELECT jsonb_agg(c ORDER BY company,item_id) FROM field_sales_catalog c) AS catalog,(SELECT data FROM field_sales_settings) AS settings,(SELECT jsonb_agg(r ORDER BY quote_id,revision) FROM field_sales_quote_revisions r) AS revisions`)).rows[0];
  const before=await read();
  await withTransaction(async()=>{
    await query(`UPDATE field_sales_settings SET data=jsonb_set(data-'companies','{companies}','{"MBBS":{"name":"Preserved name","taxBps":500},"MBT":{"taxBps":1300}}')`);
    await query(`INSERT INTO field_sales_catalog(company,item_id,sku,description,unit_rate) VALUES('MBBS','985000002','Legacy','Legacy','90')`);
    await query(await readFile(new URL('../../migrations/211_field_sales_trade.sql',import.meta.url),'utf8'));
    const state=await read();assert.equal(state.settings.companies.MBBS.name,'Preserved name');assert.equal(state.settings.companies.MBBS.taxBps,500);assert.equal(state.settings.companies.MBR.taxBps,1300);assert.equal(state.catalog.find(r=>r.item_id==='985000002').unit_rate,null);assert.deepEqual(state.revisions,before.revisions);
    await query(`INSERT INTO field_sales_catalog(company,item_id,sku,description) VALUES('MBR','985000002','New rental','New rental')`);
  },{rollback:true});assert.deepEqual(await read(),before);
});
test('T7 concurrent catalog requests serialize their reads and replacements',async()=>{
  const calls=[];let release,entered;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  const repo=createFieldSalesRepository();
  const item=rate=>({company:'MBBS',item_id:'985000003',sku:'Concurrent',description:'Concurrent',unit:'Each',unit_rate:rate,pricing:{}});
  await query(`INSERT INTO field_sales_catalog(company,item_id,sku,description,unit_rate) VALUES('MBBS','985000003','Concurrent','Concurrent','1')`);
  const first=createSalesCatalog(repo,{reader:{items:async()=>{calls.push('first');entered();await gate;return [item('2')];}}});
  const second=createSalesCatalog(repo,{reader:{items:async()=>{calls.push('second');return [item('3')];}}});
  try{
    const one=withTransaction(()=>first.price('MBBS','985000003'),{rollback:true});await started;
    const two=withTransaction(()=>second.price('MBBS','985000003'),{rollback:true});await new Promise(r=>setTimeout(r,30));assert.deepEqual(calls,['first']);release();
    assert.equal((await one).unit_rate,'2');assert.equal((await two).unit_rate,'3');assert.deepEqual(calls,['first','second']);
    assert.equal((await query(`SELECT unit_rate FROM field_sales_catalog WHERE company='MBBS' AND item_id='985000003'`)).rows[0].unit_rate,'1');
  }finally{release();await query(`DELETE FROM field_sales_catalog WHERE company='MBBS' AND item_id='985000003'`);}
});
