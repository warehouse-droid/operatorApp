// Execute through stdin in the live app. All database access is read-only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createFieldSalesRepository} from './src/field-sales/repository.js';
import {quotePdf} from './src/field-sales/pdf.js';
import {query,withTransaction,closeDb} from './src/db.js';
try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');const repo=createFieldSalesRepository(),settings=(await repo.settings()).data;
  assert.equal(settings.enabled,true);assert.equal(settings.salesOrderPostingEnabled,false);assert.notEqual(process.env.FIELD_SALES_NETSUITE_WRITES_ENABLED,'true');
  assert.equal((await query("SELECT count(*)::int n FROM schema_migrations WHERE filename='214_field_sales_combined_quotes.sql'")).rows[0].n,1);
  const rows=(await query('SELECT id,quote_number FROM field_sales_quotes WHERE quote_number IN (2,3) ORDER BY quote_number')).rows;assert.equal(rows.length,2);
  const quote=await repo.getQuote(rows[0].id),alias=await repo.getQuote(rows[1].id),list=await repo.listQuotes();
  assert.equal(quote.id,alias.id);assert.equal(quote.company,null);assert.equal(quote.snapshot.schemaVersion,3);assert.equal(quote.number,'FS-000002');assert.equal(quote.snapshot.documents.MBBS.number,'FS-MBBS-000002');assert.equal(quote.snapshot.documents.MBR.number,'FS-MBR-000003');
  assert.equal(list.filter(q=>rows.some(r=>r.id===q.id)).length,1);assert.equal((await repo.getJobsite(quote.jobsite_id)).quotes.filter(q=>rows.some(r=>r.id===q.id)).length,1);
  const originals=await Promise.all(rows.map(r=>repo.getQuote(r.id,1)));assert.equal(originals[0].number,'FS-MBBS-000002');assert.equal(originals[1].number,'FS-MBR-000003');
  assert.equal(quote.snapshot.totalMinor,originals.reduce((n,q)=>n+q.snapshot.totalMinor,0));
  const pdf=await quotePdf(quote);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');const pages=(pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length;assert.ok(pages>=2);
  for(const original of originals){assert.equal((await quotePdf(original)).subarray(0,5).toString(),'%PDF-');}
  return {quote:quote.number,companies:Object.keys(quote.snapshot.companies),oneListRow:true,originalNumbersAndRevisionsPreserved:true,pdf:{pages,bytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex')},orders:quote.orders.length,salesOrderPostingEnabled:false,restletConfigured:Boolean(process.env.FIELD_SALES_RESTLET_URL)};
 },{rollback:true});
 let unauthorizedChecks=0;
 for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){for(const path of ['quotes','quotes/ecfc27b5-1385-496a-b03f-7ddb27064da9','quotes/ecfc27b5-1385-496a-b03f-7ddb27064da9/pdf']){assert.equal((await fetch(`${base}/api/field-sales/${path}`,{signal:AbortSignal.timeout(15000)})).status,401);unauthorizedChecks++;}}
 console.log(JSON.stringify({passed:true,databaseReadOnly:true,unauthorizedChecks,...result}));
}finally{await closeDb();}
