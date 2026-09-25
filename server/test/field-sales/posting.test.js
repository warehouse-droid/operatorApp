import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test,{after} from 'node:test';
import { query,withTransaction,closeDb } from '../../src/db.js';
import { createQuotePublisher } from '../../src/field-sales/posting.js';
after(closeDb);
async function scenario(run) {
  return withTransaction(async()=>{
    const site=randomUUID(),quote=randomUUID();
    await query(`INSERT INTO field_sales_jobsites(id,name,address,address_key) VALUES($1,'Test','1 Test Rd','1 TEST RD')`,[site]);
    await query(`INSERT INTO field_sales_quotes(id,jobsite_id,created_by) VALUES($1,$2,'test')`,[quote,site]);
    await query(`INSERT INTO field_sales_quote_revisions(quote_id,revision,snapshot,created_by) VALUES($1,1,'{}','test')`,[quote]);
    for(const company of ['MBBS','MBT']) {
      const externalId=`field-sales-${quote}-${company.toLowerCase()}`;
      await query(`INSERT INTO field_sales_estimates(quote_id,company,external_id) VALUES($1,$2,$3)`,[quote,company,externalId]);
      await query(`INSERT INTO field_sales_posting_jobs(id,quote_id,revision,company,payload) VALUES($1,$2,1,$3,$4)`,[randomUUID(),quote,company,JSON.stringify({quoteId:quote,revision:1,company,externalId,lines:[{itemId:'1'}],totals:{subtotalMinor:100,taxMinor:13,totalMinor:113}})]);
    }
    await run(quote);
  },{rollback:true});
}
test('P1 uncertain create is reconciled and the successful company is not posted twice',()=>scenario(async quote=>{
  const records=new Map(),writes=[];let timeout=true;
  const transport=async(action,p)=>{
    if(action==='preflight'){return {ok:true};}
    if(action==='lookup'){return records.get(p.externalId)||{found:false};}
    writes.push(p.company);
    const remote={found:true,internalId:p.company==='MBBS'?'100':'200',reference:p.company,revision:1,payloadHash:p.payloadHash,remoteHash:'remote-'+p.company,totals:p.totals,closed:false};
    records.set(p.externalId,remote);
    if(timeout){timeout=false;throw new Error('Response lost after remote save');}return remote;
  };
  const publisher=createQuotePublisher({db:{query,transaction:withTransaction},settings:async()=>({data:{enabled:true,postingEnabled:true}})},{transport,enabled:true});
  await publisher.tick();
  await query(`UPDATE field_sales_posting_jobs SET next_attempt_at=now() WHERE quote_id=$1`,[quote]);
  await publisher.tick();await publisher.tick();
  assert.equal(writes.filter(c=>c==='MBBS').length,1);assert.equal(writes.filter(c=>c==='MBT').length,1);
  assert.equal((await query(`SELECT count(*)::int AS n FROM field_sales_posting_jobs WHERE quote_id=$1 AND state='done'`,[quote])).rows[0].n,2);
  assert.equal((await query('SELECT published_revision FROM field_sales_quotes WHERE id=$1',[quote])).rows[0].published_revision,1);
}));
test('P2 failed preflight never calls the write transport',()=>scenario(async()=>{
  let writes=0;
  const transport=async(action)=>{if(action==='preflight'){throw Object.assign(new Error('Wrong subsidiary'),{permanent:true});}if(action==='lookup'){return {found:false};}writes++;return {};};
  const publisher=createQuotePublisher({db:{query,transaction:withTransaction},settings:async()=>({data:{enabled:true,postingEnabled:true}})},{transport,enabled:true});
  await publisher.tick();assert.equal(writes,0);
}));
test('P3 mismatched remote cents, identity or closure remains attention and never marks a quote published',async()=>{
  for(const fault of [{internalId:null},{revision:2},{payloadHash:'different'},{unmodified:false},{closed:true},{totals:{subtotalMinor:100,taxMinor:14,totalMinor:114}}]){
    await scenario(async quote=>{
      const transport=async(action,p)=>action==='lookup'?{found:false}:action==='preflight'?{ok:true}:{internalId:'100',revision:1,payloadHash:p.payloadHash,remoteHash:'hash',totals:p.totals,...fault};
      const publisher=createQuotePublisher({db:{query,transaction:withTransaction},settings:async()=>({data:{enabled:true,postingEnabled:true}})},{transport,enabled:true});
      await publisher.tick();const jobs=(await query('SELECT * FROM field_sales_posting_jobs WHERE quote_id=$1 ORDER BY company',[quote])).rows;assert.equal(jobs[0].state,'attention');assert.match(jobs[0].error,/NetSuite/);assert.equal((await query('SELECT published_revision FROM field_sales_quotes WHERE id=$1',[quote])).rows[0].published_revision,null);
    });
  }
});
test('P4 unexpected remote records stop writes and repeated transport failures stop automatic retries',()=>scenario(async quote=>{
  let writes=0;
  const repo={db:{query,transaction:withTransaction},settings:async()=>({data:{enabled:true,postingEnabled:true}})};
  const unexpected=createQuotePublisher(repo,{enabled:true,transport:async action=>{if(action==='lookup'){return {found:true,internalId:'100',revision:0,unmodified:true};}writes++;return {};}});
  await unexpected.tick();assert.equal(writes,0);assert.match((await query('SELECT error FROM field_sales_posting_jobs WHERE quote_id=$1 AND company=\'MBBS\'',[quote])).rows[0].error,/unexpected existing/);
  await query(`UPDATE field_sales_posting_jobs SET state='attention' WHERE quote_id=$1 AND company='MBBS'`,[quote]);
  await query(`UPDATE field_sales_posting_jobs SET attempt=4 WHERE quote_id=$1 AND company='MBT'`,[quote]);
  const failing=createQuotePublisher(repo,{enabled:true,transport:async()=>{throw new Error('Network offline');}});await failing.tick();
  const failed=(await query(`SELECT state,attempt,error FROM field_sales_posting_jobs WHERE quote_id=$1 AND company='MBT'`,[quote])).rows[0];assert.deepEqual(failed,{state:'attention',attempt:5,error:'Network offline'});
}));
