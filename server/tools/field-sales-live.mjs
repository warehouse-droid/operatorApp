import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {query,withTransaction,closeDb} from './src/db.js';
import {config} from './src/config.js';
import {createFieldSalesRepository} from './src/field-sales/repository.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const results=[];
try{
  for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
    const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
    const page=await fetch(base+'/field-sales/');assert.equal(page.status,200);assert.match(await page.text(),/Field Sales/);assert.match(page.headers.get('cache-control'),/no-store/);
    for(const file of ['field-sales/app.js','field-sales/planner.js','field-sales/visiting.js','field-sales/quotes.js','field-sales/service-worker.js','field-sales/manifest.webmanifest','app-sidebar.js','control.js','dispatch-auth.js']){
      const response=await fetch(base+'/'+file,{headers:{'Cache-Control':'no-cache'}});assert.equal(response.status,200,file);
      assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(await readFile('/app/public/'+file)),file);
    }
    for(const route of ['/api/field-sales/status','/api/field-sales/jobsites','/api/field-sales/routes','/api/field-sales/quotes']){assert.equal((await fetch(base+route)).status,401,route);}
    results.push({base,health:200,module:200,assetHashes:9,anonymousProtectedEndpoints:4});
  }
  const database=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='15s'");
    const settings=(await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0].data;
    const tables=Number((await query("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'field_sales_%'")).rows[0].count);assert.equal(tables,18);
    assert.equal(settings.postingEnabled,false);
    let prospectReads;
    if(settings.enabled){
      const repo=createFieldSalesRepository(),started=Date.now();
      const list=await repo.listJobsites({source:'recommended',limit:50});
      const map=await repo.mapJobsites({source:'recommended',zoom:11});
      prospectReads={matching:list.total,returned:list.items.length,mapClusters:map.length,durationMs:Date.now()-started};
    }
    return {tables,enabled:settings.enabled,importsEnabled:settings.importsEnabled,postingEnabled:settings.postingEnabled,prospectReads,
      jobsites:Number((await query('SELECT count(*) FROM field_sales_jobsites')).rows[0].count),
      planning:(await query("SELECT count(*)::int AS addresses,count(DISTINCT jobsite_id)::int AS applications,count(DISTINCT data->>'ward')::int AS wards,count(DISTINCT data->>'district')::int AS districts FROM field_sales_sources WHERE source='planning' AND present")).rows[0],
      catalog:(await query('SELECT company,count(*)::int AS items FROM field_sales_catalog WHERE active GROUP BY company ORDER BY company')).rows,
      imports:(await query('SELECT source,state,record_count,error FROM field_sales_import_runs ORDER BY started_at DESC LIMIT 8')).rows};
  });
  const integrations={browserMapConfigured:Boolean(config.googleMaps.browserApiKey),serverMapConfigured:Boolean(config.googleMaps.serverApiKey),mapsMode:config.googleMaps.mode,
    netSuiteRestletConfigured:Boolean(process.env.FIELD_SALES_RESTLET_URL),netSuiteWriteGate:process.env.FIELD_SALES_NETSUITE_WRITES_ENABLED==='true'};
  console.log(JSON.stringify({passed:true,http:results,database,integrations}));
}finally{await closeDb();}
