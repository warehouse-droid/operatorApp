import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import fc from 'fast-check';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {customerFixture,fakeNetSuite} from './customer-fixture.js';
import {quotePdf} from '../../src/field-sales/pdf.js';
import {pdfText,pdfPages} from './pdf-text.js';
import {createOrderPublisher} from '../../src/field-sales/orders.js';
import {saveQuoteEvidence} from '../../src/field-sales/evidence.js';
after(closeDb);
beforeEach(()=>query("UPDATE field_sales_order_jobs SET state='attention' WHERE state IN ('pending','working','uncertain')"));
const companies=['MBBS','MBR','MBT'];
const mixed=f=>({...f.draft,schemaVersion:3,company:'',lines:companies.flatMap(company=>f.draft.lines.map(l=>({...l,id:randomUUID(),company})))});
const accept=q=>({id:q.id,revision:q.revision,confirmedBy:'Lee',confirmedAt:'2026-09-22T02:00:00Z'});

test('One mixed quote has one revision/list row and preserves every company total and PDF reference',()=>withTransaction(async()=>{
 const f=await customerFixture(),draft=mixed(f),q=(await f.cmd('quote.save',draft)).quote;
 assert.equal(q.company,null);assert.equal(q.snapshot.schemaVersion,3);assert.match(q.number,/^FS-\d{6}$/);
 assert.equal(q.snapshot.lines.length,6);assert.equal(q.snapshot.totalMinor,545643*3);assert.equal(q.orders.length,0);
 assert.equal((await f.repo.listQuotes()).filter(r=>r.created_by===f.actor.id).length,1);
 assert.equal((await f.repo.getJobsite(f.sites[0].id)).quotes.length,1);
 for(const c of companies){assert.equal(q.snapshot.companies[c].totalMinor,545643);assert.match(q.snapshot.documents[c].number,new RegExp('^FS-'+c+'-'));}
 const next=(await f.cmd('quote.save',{...draft,revision:1,note:'Shared memo'})).quote;
 assert.deepEqual(next.snapshot.documents,q.snapshot.documents);assert.equal(next.revision,2);
 assert.equal((await f.repo.getQuote(q.id,1)).snapshot.note,draft.note);
},{rollback:true}));

test('Combined PDF starts each company on its own page and keeps an overall total and saved templates',async()=>{
 const profiles=Object.fromEntries(companies.map(c=>[c,{name:c+' Company',taxBps:1300,terms:'Company terms '+c}]));
 const snapshot={schemaVersion:3,simpleDetails:true,quoteDate:'2026-09-22',customerName:'Builder',jobsite:{address:'90 Belfield Road'},note:'看见红单才上货',companyProfiles:profiles,totalMinor:678,
  documents:Object.fromEntries(companies.map((c,i)=>[c,{number:'FS-'+c+'-00000'+(i+2),validUntil:'2026-10-22'}])),
  lines:companies.map((company,i)=>({company,sku:'ONLY-'+company,description:'Material '+company,unit:'ea',quantity:'1',unitRate:String(i+1),amountMinor:(i+1)*100})),
  companies:Object.fromEntries(companies.map((c,i)=>[c,{subtotalMinor:(i+1)*100,taxMinor:(i+1)*13,totalMinor:(i+1)*113,taxBps:1300}]))};
 const pdf=await quotePdf({number:'FS-000002',selected_revision:2,snapshot}),text=pdfText(pdf);
 assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,3);
 for(const [i,c] of companies.entries()){assert.ok(text.includes('ONLY-'+c));assert.ok(text.includes(snapshot.documents[c].number));const page=pdfPages(pdf)[i];assert.ok(page.includes('ONLY-'+c));for(const other of companies.filter(o=>o!==c)){assert.ok(!page.includes('ONLY-'+other));}}
 for(const value of ['FS-000002','Quote total CAD','$6.78','看见红单才上货']){assert.ok(text.includes(value),value);}
 for(const value of ['Bill To','Ship To','Exp. Close']){assert.ok(!text.includes(value));}
 await assert.rejects(quotePdf({number:'FS-000002',selected_revision:2,snapshot},'unknown'),/company/i);
});

test('Concurrent mixed saves and confirmations create one parent and three stable order intents',async()=>{
 const f=await customerFixture(),draft=mixed(f),command={id:randomUUID(),kind:'quote.save',payload:draft};
 const [a,b]=await Promise.all([f.repo.command(f.actor,command),f.repo.command(f.actor,command)]);assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
 const q=a.quote;await Promise.all([f.cmd('quote.confirm',accept(q)),f.cmd('quote.confirm',accept(q))]);
 const jobs=(await query('SELECT * FROM field_sales_order_jobs WHERE quote_id=$1',[q.id])).rows;
 assert.equal(jobs.length,3);assert.equal(new Set(jobs.map(j=>j.external_id)).size,3);
 for(const j of jobs){assert.equal(j.quote_id,q.id);assert.equal(j.payload.quoteId,q.id);assert.equal(j.payload.number,q.number);assert.ok(j.payload.lines.every(l=>l.company===j.company));assert.equal(j.payload.totals.totalMinor,545643);}
 await assert.rejects(f.cmd('quote.save',{...draft,revision:1}),/confirmed/i);
 const copy=(await f.cmd('quote.copy',{id:q.id,newId:randomUUID()})).quote;
 assert.equal(copy.snapshot.lines.length,6);assert.equal(copy.confirmation,null);assert.equal(copy.orders.length,0);
 for(const c of companies){assert.notEqual(copy.snapshot.documents[c].id,q.snapshot.documents[c].id);}
});

test('Combined preflight is atomic and evidence belongs to the parent revision and actor',()=>withTransaction(async()=>{
 const f=await customerFixture(),draft=mixed(f),q=(await f.cmd('quote.save',draft)).quote;
 const evidence={id:randomUUID(),revision:1,name:'yes.pdf',base64:Buffer.from('%PDF-1.4 test').toString('base64')};
 await saveQuoteEvidence(f.repo.db,f.actor,q.id,evidence);
 await assert.rejects(f.cmd('quote.confirm',{...accept(q),evidenceIds:[randomUUID()]}),/evidence/);
 await query("UPDATE field_sales_catalog SET active=false WHERE company='MBR' AND item_id=$1",[draft.lines[0].itemId]);
 await assert.rejects(f.cmd('quote.confirm',{...accept(q),evidenceIds:[evidence.id]}),/inactive/);
 assert.equal((await f.repo.getQuote(q.id)).confirmation,null);assert.equal((await f.repo.getQuote(q.id)).orders.length,0);
 await query("UPDATE field_sales_catalog SET active=true WHERE company='MBR' AND item_id=$1",[draft.lines[0].itemId]);
 await f.cmd('quote.confirm',{...accept(q),evidenceIds:[evidence.id]});
 assert.deepEqual((await f.repo.getQuote(q.id)).confirmation.evidenceIds,[evidence.id]);
},{rollback:true}));

test('One parent reconciles three orders independently, with shared MBT/MBR customer and no duplicate retry',async()=>{
 const f=await customerFixture(),q=(await f.cmd('quote.save',mixed(f))).quote,remote=fakeNetSuite();let failMBR=true;
 const transport=async(action,p)=>{const result=await remote.transport(action,p);if(action==='order.create'&&p.company==='MBR'&&failMBR){throw new Error('Response lost after MBR saved');}return result;};
 await f.cmd('quote.confirm',accept(q));
 const workers=[1,2,3].map(()=>createOrderPublisher(f.repo,{enabled:true,transport}));await Promise.all(workers.map(w=>w.tick()));
 let saved=await f.repo.getQuote(q.id);assert.equal(saved.orders.filter(j=>j.state==='done').length,2);assert.equal(saved.orders.find(j=>j.company==='MBR').state,'uncertain');
 assert.equal(remote.customers.size,2);assert.equal(remote.orders.size,3);failMBR=false;
 await query('UPDATE field_sales_order_jobs SET next_attempt_at=now() WHERE quote_id=$1',[q.id]);await workers[0].tick();
 saved=await f.repo.getQuote(q.id);assert.ok(saved.orders.every(j=>j.state==='done'));assert.equal(remote.calls.filter(a=>a==='order.create').length,3);
 await query("UPDATE field_sales_order_jobs SET state='attention' WHERE quote_id=$1 AND company IN ('MBBS','MBR')",[q.id]);
 const mbr=saved.orders.find(j=>j.company==='MBR');await f.cmd('quote.order.retry',{...accept(q),orderId:mbr.id});
 saved=await f.repo.getQuote(q.id);assert.equal(saved.orders.find(j=>j.company==='MBR').state,'uncertain');assert.equal(saved.orders.find(j=>j.company==='MBBS').state,'attention');
 await assert.rejects(f.cmd('quote.order.retry',{...accept(q),orderId:randomUUID()}),/order/i);
});

test('Hostile mixed saves roll back completely; stale revisions and obsolete batch commands require review',()=>withTransaction(async()=>{
 const f=await customerFixture(),draft=mixed(f);
 for(const patch of [{lines:[]},{lines:[null]},{lines:[{...draft.lines[0],company:'OTHER'}]},{lines:[{...draft.lines[0],quantity:'-1'}]},{lines:[{...draft.lines[0],id:'bad" onfocus="'}]},{fieldSalesCustomerId:''},{customerRepresentativeId:randomUUID()},{expectedTaxBps:{MBBS:0,MBT:1300,MBR:1300}},{lines:draft.lines.map((l,i)=>i===5?{...l,itemId:'absent'}:l)}]){await assert.rejects(f.cmd('quote.save',{...draft,...patch}),e=>[400,409].includes(e.status));}
 assert.equal((await f.repo.listQuotes()).filter(q=>q.created_by===f.actor.id).length,0);
 await f.cmd('quote.save',draft);await assert.rejects(f.cmd('quote.save',{...draft,revision:0}),/changed/i);
 await assert.rejects(f.cmd('quote.saveGroup',{id:randomUUID(),quotes:[f.draft]}),e=>e.code==='FIELD_SALES_QUOTE_UPGRADE');
},{rollback:true}));

test('Mixed quote conservation property survives arbitrary company selection, quantities and company removal',()=>withTransaction(async()=>{
 const f=await customerFixture();
 await fc.assert(fc.asyncProperty(fc.array(fc.record({company:fc.constantFrom(...companies),quantity:fc.integer({min:1,max:100}),cents:fc.integer({min:0,max:100000})}),{minLength:1,maxLength:15}),async rows=>{
  const draft={...mixed(f),id:randomUUID(),lines:rows.map(r=>({...f.draft.lines[0],id:randomUUID(),company:r.company,quantity:String(r.quantity),unitRate:(r.cents/100).toFixed(2)}))};
  const q=(await f.cmd('quote.save',draft)).quote;
  const subtotal=rows.reduce((sum,r)=>sum+r.quantity*r.cents,0),tax=companies.reduce((sum,c)=>sum+Math.round(rows.filter(r=>r.company===c).reduce((n,r)=>n+r.quantity*r.cents,0)*.13),0);
  assert.equal(q.snapshot.totalMinor,subtotal+tax);assert.equal(q.snapshot.lines.length,rows.length);assert.equal(Object.keys(q.snapshot.documents).length,new Set(rows.map(r=>r.company)).size);
  const next=(await f.cmd('quote.save',{...draft,revision:1,lines:[draft.lines[0]]})).quote;
  assert.deepEqual(Object.keys(next.snapshot.companies),[rows[0].company]);assert.equal((await f.repo.getQuote(q.id,1)).snapshot.lines.length,rows.length);
 }),{numRuns:20});
},{rollback:true}));

test('Receipt migration preserves original revisions/numbers, merges only current unconfirmed batches and resolves aliases',()=>withTransaction(async()=>{
 const migration=new URL('../../migrations/214_field_sales_combined_quotes.sql',import.meta.url);assert.ok(existsSync(migration),'combined quote migration exists');
 const f=await customerFixture(),parts=[];
 for(const company of ['MBBS','MBR']){parts.push((await f.cmd('quote.save',{...f.draft,id:randomUUID(),company,lines:f.draft.lines.map(l=>({...l,company}))})).quote);}
 const unrelated=(await f.cmd('quote.save',{...f.draft,id:randomUUID()})).quote;
 await query("INSERT INTO field_sales_commands(id,actor_id,kind,payload_hash,response) VALUES($1,$2,'quote.saveGroup','test',$3)",[randomUUID(),f.actor.id,JSON.stringify({quotes:parts})]);
 const sql=readFileSync(migration,'utf8').split('-- Consolidate proven batches')[1];await query(sql);
 const root=await f.repo.getQuote(parts[0].id),alias=await f.repo.getQuote(parts[1].id);
 assert.equal(root.id,alias.id);assert.equal(root.revision,2);assert.equal(root.snapshot.lines.length,4);assert.equal(root.snapshot.totalMinor,545643*2);
 assert.equal(new Set(root.snapshot.lines.map(l=>l.id)).size,4,'combined revision has unique item identities');
 for(const p of parts){assert.deepEqual((await f.repo.getQuote(p.id,1)).snapshot,p.snapshot);assert.equal(root.snapshot.documents[p.company].number,p.number);}
 assert.equal((await f.repo.getQuote(unrelated.id)).revision,1);assert.equal((await f.repo.getJobsite(f.sites[0].id)).quotes.length,2);
 await assert.rejects(f.cmd('quote.save',{...f.draft,id:parts[1].id,company:'MBR',revision:1}),/combined|parent/i);
 await assert.rejects(f.cmd('quote.confirm',accept(parts[1])),/combined|parent/i);
 await query(sql);assert.equal((await f.repo.getQuote(root.id)).revision,2);
},{rollback:true}));

test('Migration skips accepted, independently edited, differently addressed and differently annotated batches',()=>withTransaction(async()=>{
 const f=await customerFixture(),sql=readFileSync(new URL('../../migrations/214_field_sales_combined_quotes.sql',import.meta.url),'utf8').split('-- Consolidate proven batches')[1];
 for(const mode of ['accepted','edited','site','memo']){
  const parts=[];for(const company of ['MBBS','MBR']){parts.push((await f.cmd('quote.save',{...f.draft,id:randomUUID(),company,jobsiteId:mode==='site'&&company==='MBR'?f.sites[1].id:f.draft.jobsiteId,note:mode==='memo'&&company==='MBR'?'Other memo':f.draft.note,lines:f.draft.lines.map(l=>({...l,company}))})).quote);}
  await query("INSERT INTO field_sales_commands(id,actor_id,kind,payload_hash,response) VALUES($1,$2,'quote.saveGroup','test',$3)",[randomUUID(),f.actor.id,JSON.stringify({quotes:parts})]);
  if(mode==='accepted'){await f.cmd('quote.confirm',accept(parts[1]));}
  if(mode==='edited'){await f.cmd('quote.save',{...parts[1].snapshot,id:parts[1].id,revision:1,jobsiteId:f.draft.jobsiteId,lines:parts[1].snapshot.lines.map(l=>({...l,quantity:'1'}))});}
  await query(sql);
  for(const p of parts){const current=await f.repo.getQuote(p.id);assert.equal(current.id,p.id);assert.equal(current.parent_quote_id,null);assert.equal(current.company,p.company);assert.deepEqual((await f.repo.getQuote(p.id,1)).snapshot,p.snapshot);}
 }
},{rollback:true}));
