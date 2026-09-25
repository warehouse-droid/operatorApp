// Execute through stdin in the live app container. Database work is read-only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFieldSalesRepository } from './src/field-sales/repository.js';
import {quoteDates,splitCompanyDraft} from './public/field-sales/quote-drafts.js';
import { quotePdf } from './src/field-sales/pdf.js';
import { calculateQuote,torontoDate } from './public/field-sales/domain.js';
import { query,withTransaction,closeDb } from './src/db.js';

try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const repo=createFieldSalesRepository(),settings=(await repo.settings()).data;
  assert.equal(settings.enabled,true);
  assert.equal(settings.salesOrderPostingEnabled,false);
  assert.notEqual(process.env.FIELD_SALES_NETSUITE_WRITES_ENABLED,'true');
  const types=await repo.listCustomerTypes(),customers=await repo.listCustomers(),quotes=await repo.listQuotes();
  assert.ok(types.length>=4);assert.ok(Array.isArray(customers.items));assert.ok(Array.isArray(quotes));
  const migration=await query("SELECT count(*)::int AS count FROM schema_migrations WHERE filename='213_field_sales_customer_quotes.sql'");
  assert.equal(migration.rows[0].count,1);
  let sampleId=0;const grouped=splitCompanyDraft({id:'sample',lines:['MBBS','MBT','MBR'].map(company=>({company}))},()=>`sample-${++sampleId}`);assert.equal(grouped.length,3);assert.ok(grouped.every(p=>p.lines.length===1&&p.lines[0].company===p.company));
  const pdfs=[];
  for(const company of ['MBBS','MBT','MBR']){
   const snapshot={...calculateQuote({lines:[{id:'verification',company,itemId:'sample',sku:'SAMPLE',description:'Sample material 建筑材料',unit:'EA',quantity:'2',unitRate:'25'}]},settings.companies),schemaVersion:2,simpleDetails:true,...quoteDates(torontoDate(),settings.companies[company]),company,companyProfiles:{[company]:settings.companies[company]},jobsite:{address:'Sample jobsite'},customerName:'Verification sample',billToAddress:'Toronto, Ontario',shipToAddress:'Sample jobsite',note:'Sample memo / 报价备注'};
   const pdf=await quotePdf({number:`FS-${company}-SAMPLE`,selected_revision:1,snapshot});
   assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>10000);
   pdfs.push({company,bytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex')});
  }
  return {customerTypes:types.length,automaticCompanyGrouping:true,customerListReadable:true,quoteListReadable:true,migrationApplied:true,pdfs,salesOrderPostingEnabled:false,restletConfigured:Boolean(process.env.FIELD_SALES_RESTLET_URL)};
 },{rollback:true});
 let unauthorizedChecks=0;
 for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
  for(const [path,method] of [['customer-records','GET'],['customer-types','GET'],['integration-status','GET'],['template-preview','POST'],['quote-evidence/00000000-0000-4000-8000-000000000001','GET'],['quotes/00000000-0000-4000-8000-000000000001/evidence','POST']]){
   const response=await fetch(`${base}/api/field-sales/${path}`,{method,signal:AbortSignal.timeout(15000)});
   assert.equal(response.status,401);unauthorizedChecks++;
  }
 }
 console.log(JSON.stringify({passed:true,at:new Date().toISOString(),databaseReadOnly:true,unauthorizedChecks,...result}));
} finally {await closeDb();}
