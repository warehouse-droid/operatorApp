// Run through stdin in the app container; this changes only local MBBS settings.
// FIELD_SALES_SETTINGS_ACTION: prepare, rehearse, apply, verify or rollback.
// FIELD_SALES_SETTINGS_BACKUP: private JSON path retained across those commands.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {query,withTransaction,closeDb} from './src/db.js';
import {quotePdf} from './src/field-sales/pdf.js';
import {calculateQuote,torontoDate} from './public/field-sales/domain.js';
import {quoteDates} from './public/field-sales/quote-drafts.js';

const action=process.env.FIELD_SALES_SETTINGS_ACTION||'verify';
const backup=process.env.FIELD_SALES_SETTINGS_BACKUP;
assert.ok(backup,'Set a private backup path');
const actor='system:authorized-field-sales-settings-20260922';
const patch={name:'Mr Bin Building Supply LTD',address:'3445 Kennedy Road\nToronto ON M1V 4Y3',phone:'(416) 912-9555',taxNumber:'719366486',subsidiaryId:'1',salesOrderFormId:'156',customerStatusId:'13',termsId:'4',currencyId:'1',taxCodeId:'11',locationId:'1',pickupMethodId:'1',deliveryMethodId:'2',taxBps:1300};
const sources={sample:'QuoteSample.pdf / ESTB01236 (company header, address and phone)',quote:'ESTB14950 / 1004580 / 2026-09-21',salesOrder:'SOB120978 / 1004792 (form 156)',delivery:'SOB120971 (method 2)',location:'Active 3445 / internal ID 1 / MBBS subsidiary 1',tax:'Latest quote item tax code 11 / CA-S-ON / 13%',customerStatus:'Latest quote customer status 13 / CUSTOMER-Closed Won'};
const current=async()=>(await query('SELECT * FROM field_sales_settings WHERE singleton')).rows[0];
const same=(a,b)=>assert.deepEqual(a,b);
function noDefaultCustomer(data){for(const profile of Object.values(data.companies)){for(const key of Object.keys(profile)){assert.ok(!/^(?:default)?customer(?:Id)?$/i.test(key),'Unexpected company default customer');}}}
function nextData(before){const data=structuredClone(before.data);data.companies.MBBS={...data.companies.MBBS,...patch};noDefaultCustomer(data);return data;}
async function apply(before,rehearse=false){
 return withTransaction(async()=>{
  const locked=(await query('SELECT * FROM field_sales_settings WHERE singleton FOR UPDATE')).rows[0];
  assert.equal(locked.revision,before.revision,'Settings changed since backup');same(locked.data,before.data);
  const data=nextData(before);
  await query('UPDATE field_sales_settings SET data=$1,revision=revision+1,updated_at=now(),updated_by=$2 WHERE singleton',[JSON.stringify(data),actor]);
  await query("INSERT INTO field_sales_audit(actor_id,action,target_id,detail) VALUES($1,'settings.update','settings',$2)",[actor,JSON.stringify({reason:'User requested MBBS defaults from recent quote; default location 3445; no default customer',company:'MBBS',sources,previousRevision:before.revision,previousProfile:before.data.companies.MBBS,profile:data.companies.MBBS})]);
  const saved=await current();same(saved.data,data);assert.equal(saved.revision,before.revision+1);
  return saved;
 },{rollback:rehearse});
}
try{
 assert.notEqual(process.env.FIELD_SALES_NETSUITE_WRITES_ENABLED,'true','Do not change settings while external posting is enabled');
 if(action==='prepare'){
  const before=await current();noDefaultCustomer(before.data);
  await writeFile(backup,JSON.stringify({before,after:nextData(before),sources,preparedAt:new Date().toISOString()},null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({prepared:true,revision:before.revision,patch,sources,unverified:['customerFormId'],noDefaultCustomer:true}));
 }else{
  const state=JSON.parse(await readFile(backup,'utf8'));
  if(action==='rehearse'){
   const prior=await current();same(prior.data,state.before.data);assert.equal(prior.revision,state.before.revision);
   const count=await query('SELECT count(*)::int AS n FROM field_sales_audit WHERE actor_id=$1',[actor]);
   await apply(state.before,true);const restored=await current();same(restored,prior);
   same((await query('SELECT count(*)::int AS n FROM field_sales_audit WHERE actor_id=$1',[actor])).rows,count.rows);
   console.log(JSON.stringify({rehearsalPassed:true,settingsAndAuditRolledBack:true}));
  }else if(action==='apply'){
   const saved=await apply(state.before);console.log(JSON.stringify({applied:true,revision:saved.revision,company:'MBBS',location:'3445',locationId:saved.data.companies.MBBS.locationId,profile:saved.data.companies.MBBS}));
  }else if(action==='rollback'){
   await withTransaction(async()=>{
    const row=(await query('SELECT * FROM field_sales_settings WHERE singleton FOR UPDATE')).rows[0];
    same(row.data,state.after);assert.equal(row.revision,state.before.revision+1);
    await query('UPDATE field_sales_settings SET data=$1,revision=revision+1,updated_at=now(),updated_by=$2 WHERE singleton',[JSON.stringify(state.before.data),actor]);
    await query("INSERT INTO field_sales_audit(actor_id,action,target_id,detail) VALUES($1,'settings.rollback','settings',$2)",[actor,JSON.stringify({reason:'Restore prior MBBS profile',previousRevision:row.revision})]);
   });console.log(JSON.stringify({rolledBack:true}));
  }else if(action==='verify'){
   const saved=await current();same(saved.data,state.after);assert.equal(saved.revision,state.before.revision+1);noDefaultCustomer(saved.data);
   const profile=saved.data.companies.MBBS;
   const snapshot={...calculateQuote({lines:[{id:'sample',company:'MBBS',itemId:'sample',description:'Template verification sample',quantity:'2',unitRate:'25',unit:'EA'}]},saved.data.companies),schemaVersion:2,simpleDetails:true,company:'MBBS',companyProfiles:{MBBS:profile},...quoteDates(torontoDate(),profile),customerName:'Template verification sample',jobsite:{address:'Sample jobsite'}};
   const pdf=await quotePdf({number:'FS-MBBS-SAMPLE',selected_revision:1,snapshot});assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
   await writeFile(backup+'.pdf',pdf,{mode:0o600});
   console.log(JSON.stringify({verified:true,revision:saved.revision,profile,otherSettingsPreserved:true,noDefaultCustomer:true,externalWritesEnabled:false,customerFormStillNeeded:!profile.customerFormId,pdf:{bytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex')}}));
  }else{throw Error('Unknown action');}
 }
}finally{await closeDb();}
