import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fc from 'fast-check';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {customerFixture} from './customer-fixture.js';
import {torontoDate} from '../../public/field-sales/domain.js';
import {quoteDates,splitCompanyDraft} from '../../public/field-sales/quote-drafts.js';
import {quotePdf} from '../../src/field-sales/pdf.js';
import {pdfText} from './pdf-text.js';
after(closeDb);
const mixed=f=>['MBBS','MBT','MBR'].map(company=>({...f.draft,id:randomUUID(),company,lines:f.draft.lines.map(l=>({...l,id:randomUUID(),company}))}));

test('Automatic grouping preserves every item once with stable company IDs and independent totals',()=>{
 fc.assert(fc.property(fc.array(fc.constantFrom('MBBS','MBT','MBR'),{minLength:1,maxLength:60}),companies=>{
  const draft={id:randomUUID(),revision:0,lines:companies.map((company,i)=>({id:String(i),company,quantity:'2',unitRate:'1.23'}))};
  const parts=splitCompanyDraft(draft,randomUUID);
  assert.equal(parts.length,new Set(companies).size);assert.equal(new Set(parts.map(p=>p.id)).size,parts.length);
  assert.deepEqual(parts.flatMap(p=>p.lines.map(l=>l.id)).sort(),draft.lines.map(l=>l.id).sort());
  for(const part of parts){assert.ok(part.lines.every(l=>l.company===part.company));}
  draft.companyQuotes=Object.fromEntries(parts.map(p=>[p.company,{id:p.id,revision:p.revision}]));
  assert.deepEqual(splitCompanyDraft(draft,()=>{throw new Error('IDs must remain stable');}),parts);
 }));
 assert.throws(()=>splitCompanyDraft({id:randomUUID(),lines:[]},randomUUID),/item/i);
 assert.throws(()=>splitCompanyDraft({id:randomUUID(),lines:[{company:'unknown'}]},randomUUID),/company/i);
 const id=randomUUID(),existing={id,company:'MBBS',revision:3,lines:[{company:'MBT',id:'x'}]};
 const parts=splitCompanyDraft(existing,randomUUID);assert.equal(parts.find(p=>p.company==='MBBS').id,id);assert.deepEqual(parts.find(p=>p.company==='MBBS').lines,[]);assert.equal(parts.find(p=>p.company==='MBBS').revision,3);
});

test('Automatic expiry respects configured days, leap years and the default 30 days',()=>{
 assert.deepEqual(quoteDates('2026-09-22'),{quoteDate:'2026-09-22',validUntil:'2026-10-22'});
 assert.equal(quoteDates('2028-02-28',{validityDays:2}).validUntil,'2028-03-01');
 assert.equal(quoteDates('2026-12-31',{validityDays:1}).validUntil,'2027-01-01');
 assert.equal(quoteDates('2026-09-22',{validityDays:0}).validUntil,'2026-09-22');
 fc.assert(fc.property(fc.integer({min:0,max:3650}),days=>{const d=quoteDates('2026-01-01',{validityDays:days});assert.equal((Date.parse(d.validUntil)-Date.parse(d.quoteDate))/86400000,days);}));
});

test('Mixed save is atomic, retryable and uses server date and configured expiry without quote address input',()=>withTransaction(async()=>{
 const f=await customerFixture(),parts=mixed(f),payload={...f.draft,schemaVersion:3,company:'',lines:parts.flatMap(p=>p.lines)},command={id:randomUUID(),kind:'quote.save',payload};
 const settings=await f.repo.settings();settings.data.companies.MBT.validityDays=45;await f.repo.saveSettings(f.admin,settings);
 const {quote:q}=await f.repo.command(f.actor,command);assert.equal(q.snapshot.lines.length,6);
 assert.equal((await f.repo.command(f.actor,command)).quote.id,q.id);
 assert.equal(q.revision,1);assert.equal(q.snapshot.totalMinor,545643*3);assert.equal(q.snapshot.quoteDate,torontoDate());assert.equal(q.snapshot.simpleDetails,true);assert.equal(q.snapshot.expectedClose,'');
 for(const company of Object.keys(q.snapshot.companies)){assert.equal(q.snapshot.documents[company].validUntil,quoteDates(torontoDate(),settings.data.companies[company]).validUntil);}
 const next={...payload,revision:1,note:'Changed memo',lines:structuredClone(payload.lines)};next.lines.at(-1).itemId='missing';
 await assert.rejects(f.cmd('quote.save',next),/active.*item/i);assert.equal((await f.repo.getQuote(q.id)).revision,1);
 await f.cmd('quote.confirm',{id:q.id,revision:1,confirmedBy:'Lee',confirmedAt:new Date().toISOString()});
 next.lines=payload.lines;await assert.rejects(f.cmd('quote.save',next),/confirmed/i);assert.equal((await f.repo.getQuote(q.id)).revision,1);
},{rollback:true}));

test('Concurrent retries create one combined quote without duplicate revisions',async()=>{
 const f=await customerFixture(),parts=mixed(f),payload={...f.draft,schemaVersion:3,company:'',lines:parts.flatMap(p=>p.lines)},command={id:randomUUID(),kind:'quote.save',payload};
 const [a,b]=await Promise.all([f.repo.command(f.actor,command),f.repo.command(f.actor,command)]);
 assert.equal(a.quote.id,b.quote.id);
 assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_quote_revisions WHERE quote_id=$1',[payload.id])).rows[0].n,1);
});

test('Obsolete batches require review without writing split quotes, and validity is bounded',()=>withTransaction(async()=>{
 const f=await customerFixture(),parts=mixed(f);
 for(const quotes of [[],[null],parts.concat(parts[0]),[parts[0],{...parts[1],company:'MBBS'}],[parts[0],{...parts[1],jobsiteId:f.sites[1].id}],[parts[0],{...parts[1],lines:[{...parts[1].lines[0],quantity:'-1'}]}]]){
  await assert.rejects(f.cmd('quote.saveGroup',{id:randomUUID(),quotes}),e=>e.status===400||e.status===409);
 }
 assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_quotes WHERE created_by=$1',[f.actor.id])).rows[0].n,0);
 for(const validityDays of [-1,1.5,3651]){assert.throws(()=>quoteDates('2026-09-22',{validityDays}),/validity/);}
},{rollback:true}));

test('Simple quote PDF omits address blocks and expected close while retaining customer, site and dates',()=>withTransaction(async()=>{
 const f=await customerFixture(),q=(await f.cmd('quote.save',{...f.draft,quoteDate:'2000-01-01',validUntil:'2000-01-02',expectedClose:'2000-01-03',billToAddress:'Bad override',shipToAddress:'Bad shipping'})).quote;
 const text=pdfText(await quotePdf(q));
 assert.ok(!text.includes('Bill To'));assert.ok(!text.includes('Ship To'));assert.ok(!text.includes('Exp. Close'));assert.ok(!text.includes('Bad override'));
 for(const value of ['Example Builder','90 Belfield Road',torontoDate(),'5,456.43','看见红单才上货']){assert.ok(text.includes(value),value);}
 await f.cmd('quote.confirm',{id:q.id,revision:1,confirmedBy:'Lee',confirmedAt:new Date().toISOString()});
 const payload=(await query('SELECT payload FROM field_sales_order_jobs WHERE quote_id=$1',[q.id])).rows[0].payload;
 assert.equal(payload.useCustomerBilling,true);assert.equal(payload.shipToAddress,'90 Belfield Road');
},{rollback:true}));
