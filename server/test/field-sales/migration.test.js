import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { query,withTransaction,closeDb } from '../../src/db.js';
import { createFieldSalesRepository } from '../../src/field-sales/repository.js';
import { createQuotePublisher } from '../../src/field-sales/posting.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
test('M1 additive migration can be rehearsed and rolled back without changing existing data',async()=>{
  const before=(await query(`SELECT (SELECT count(*) FROM operators)::int AS operators,(SELECT count(*) FROM field_sales_quotes)::int AS quotes,(SELECT data FROM field_sales_settings) AS settings`)).rows[0];
  await withTransaction(async()=>{
    const tables=(await query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'field_sales_%'`)).rows.map(r=>r.tablename);
    assert.equal(tables.length,26);
    for(const table of tables){assert.match(table,/^field_sales_[a-z_]+$/);await query(`DROP TABLE ${table} CASCADE`);}
    await query('DROP FUNCTION field_sales_immutable_quote()');
    await query(await readFile(new URL('../../migrations/210_field_sales.sql',import.meta.url),'utf8'));
    const repo=createFieldSalesRepository();assert.equal((await repo.settings()).data.enabled,false);assert.equal((await repo.settings()).data.postingEnabled,false);
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,$1,'test','test','field_sales',ARRAY['field_sales'])`,[randomUUID()]);
    const site=randomUUID(),quote=randomUUID();await query(`INSERT INTO field_sales_jobsites(id,name,address,address_key) VALUES($1,'Rollback','1 Test','1 TEST')`,[site]);await query(`INSERT INTO field_sales_quotes(id,jobsite_id,created_by) VALUES($1,$2,'test')`,[quote,site]);await query(`INSERT INTO field_sales_quote_revisions(quote_id,revision,snapshot,created_by) VALUES($1,1,'{}','test')`,[quote]);
    await assert.rejects(withTransaction(()=>query(`UPDATE field_sales_quote_revisions SET snapshot='{"changed":true}' WHERE quote_id=$1`,[quote])),/immutable/);
  },{rollback:true});
  const afterState=(await query(`SELECT (SELECT count(*) FROM operators)::int AS operators,(SELECT count(*) FROM field_sales_quotes)::int AS quotes,(SELECT data FROM field_sales_settings) AS settings`)).rows[0];assert.deepEqual(afterState,before);
});
test('M2 exhausted merge chains and unavailable outbox storage produce explicit failures',()=>withTransaction(async()=>{
  const ids=Array.from({length:21},()=>randomUUID());
  for(const id of ids){await query(`INSERT INTO field_sales_jobsites(id,name,address,address_key) VALUES($1,'Chain','1 Test','1 TEST')`,[id]);}
  for(let i=0;i<ids.length-1;i++){await query('UPDATE field_sales_jobsites SET merged_into=$2 WHERE id=$1',[ids[i],ids[i+1]]);}
  const repo=createFieldSalesRepository();await assert.rejects(repo.getJobsite(ids[0]),/merge chain needs review/);
  await query(`UPDATE field_sales_settings SET data=data||'{"enabled":true,"postingEnabled":true}'::jsonb`);
  await query('ALTER TABLE field_sales_posting_jobs RENAME TO field_sales_posting_unavailable');
  const publisher=createQuotePublisher(repo,{enabled:true,transport:async()=>{throw new Error('Transport must not be called');}});
  await assert.rejects(publisher.tick(),e=>e.code==='42P01');
},{rollback:true}));

test('M3 customer migration preserves legacy mixed quotes, estimate links and revision bytes, with rollback',async()=>{
 const before=(await query(`SELECT (SELECT count(*) FROM field_sales_customers) AS customers,(SELECT count(*) FROM field_sales_quotes) AS quotes,(SELECT data FROM field_sales_settings) AS settings`)).rows[0];
 await withTransaction(async()=>{
  await query('ALTER TABLE field_sales_quotes DROP COLUMN company,DROP COLUMN customer_id,DROP COLUMN representative_id,DROP COLUMN confirmation,DROP COLUMN copied_from');
  for(const name of ['order_jobs','quote_evidence','customer_accounts','customer_sites','customer_type_links','customer_representatives','customer_types','customers']){await query(`DROP TABLE field_sales_${name} CASCADE`);}
  const site=randomUUID(),quote=randomUUID(),snapshot={lines:[{company:'MBBS',quantity:'3',unitRate:'19.99'},{company:'MBT',quantity:'2',unitRate:'100'}],note:'Legacy immutable memo',totalMinor:29377};
  await query(`INSERT INTO field_sales_jobsites(id,name,address,address_key) VALUES($1,'Migration','1 Migration Road','1 MIGRATION ROAD')`,[site]);
  await query(`INSERT INTO field_sales_quotes(id,jobsite_id,created_by) VALUES($1,$2,'test')`,[quote,site]);
  await query(`INSERT INTO field_sales_quote_revisions(quote_id,revision,snapshot,created_by) VALUES($1,1,$2,'test')`,[quote,JSON.stringify(snapshot)]);
  await query(`INSERT INTO field_sales_estimates(quote_id,company,external_id,netsuite_id) VALUES($1,'MBBS',$2,'1234')`,[quote,'field-sales-'+quote+'-mbbs']);
  const read=async()=>(await query('SELECT snapshot::text AS bytes FROM field_sales_quote_revisions WHERE quote_id=$1',[quote])).rows[0].bytes;
  const bytes=await read();await query(await readFile(new URL('../../migrations/213_field_sales_customer_quotes.sql',import.meta.url),'utf8'));
  assert.equal(await read(),bytes);const legacy=await createFieldSalesRepository().getQuote(quote);
  assert.equal(legacy.company,null);assert.equal(legacy.estimates[0].netsuite_id,'1234');assert.deepEqual(legacy.snapshot,snapshot);
  assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_customer_types')).rows[0].n,4);
  assert.equal((await createFieldSalesRepository().settings()).data.salesOrderPostingEnabled,false);
 },{rollback:true});
 assert.deepEqual((await query(`SELECT (SELECT count(*) FROM field_sales_customers) AS customers,(SELECT count(*) FROM field_sales_quotes) AS quotes,(SELECT data FROM field_sales_settings) AS settings`)).rows[0],before);
});
