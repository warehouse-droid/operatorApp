import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { query } from '../../src/db.js';
import { createOperator,loginOperator,getOperatorByToken } from '../../src/auth-repository.js';
import { createFieldSalesRepository } from '../../src/field-sales/repository.js';
import { createSalesCatalog } from '../../src/field-sales/catalog.js';
import { createCityImporter } from '../../src/field-sales/importer.js';
import { createFieldSalesRouter } from '../../src/field-sales/router.js';

export async function httpFixture({cityFetchJson,reader,postingEnabled=false}={}) {
  if(process.env.MBT_TEST_ISOLATED!=='1'||!String(process.env.DATABASE_URL).includes('mbt_test')){throw new Error('Disposable database required.');}
  const original=(await query('SELECT * FROM field_sales_settings')).rows[0];
  const actors={};
  for(const role of ['admin','field_sales','sales']) {
    const username=`field-test-${role}-${randomUUID()}`,password=randomUUID();
    await createOperator({username,password,displayName:`Test ${role}`,role});actors[role]={...await loginOperator(username,password),username,password};
  }
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{enabled}','true'),revision=1 WHERE singleton`);
  await query(`INSERT INTO field_sales_catalog(company,item_id,sku,description,unit,unit_rate) VALUES('MBBS','92000001','FS-BLOCK','Construction block','Each','19.99'),('MBT','92000002','FS-BIN','20 yard bin','Each','100'),('MBR','92000003','FS-RENTAL','Excavator rental','Day','50') ON CONFLICT(company,item_id) DO UPDATE SET active=true,unit_rate=EXCLUDED.unit_rate,pricing='{}'::jsonb`);
  const repo=createFieldSalesRepository(undefined,{postingEnabled});
  // Network boundary fixture: a deterministic catalog without production credentials.
  reader||={items:async(company,cfg,id)=>(await query('SELECT * FROM field_sales_catalog WHERE company=$1 AND active AND ($2::text IS NULL OR item_id=$2)',[company,id||null])).rows};
  const site=(await repo.command(actors.field_sales.operator,{id:randomUUID(),kind:'jobsite.save',payload:{id:randomUUID(),name:'Field Test · Belfield',address:'90 Belfield Road',latitude:43.709,longitude:-79.572,district:'Etobicoke-York',ward:'01',postalPrefix:'M9W'}})).jobsite;
  const route=(await repo.command(actors.field_sales.operator,{id:randomUUID(),kind:'route.save',payload:{id:randomUUID(),name:'Field Test afternoon',date:'2026-09-18',period:'afternoon',areas:['Etobicoke North','M9W'],stops:[{id:randomUUID(),jobsiteId:site.id}]}})).route;
  const source=readFileSync(new URL('../../src/server.js',import.meta.url),'utf8'),scope=vm.createContext({getOperatorByToken});
  for(const name of ['bearerToken','requireOperator']){const marker=source.includes(`async function ${name}(`)?`async function ${name}(`:`function ${name}(`;const start=source.indexOf(marker),end=source.indexOf('\n}',start)+2;vm.runInContext(source.slice(start,end),scope);}
  const maps={estimateRoute:async p=>({source:'google_routes_v2',driveMinutes:10*(p.stops.length-1),legMinutes:p.stops.slice(1).map(()=>10),distanceMeters:5000,routePath:[]}),geocode:async()=>({latitude:43.7,longitude:-79.5})};
  const app=express();app.use(express.json({limit:'25mb'}));app.use(express.static(new URL('../../public/',import.meta.url).pathname));
  app.post('/api/auth/login',async(req,res)=>{const result=await loginOperator(req.body.username,req.body.password);res.status(result?200:401).json(result||{error:'Login required'});});
  app.use('/api/field-sales',scope.requireOperator,createFieldSalesRouter({repo,catalog:createSalesCatalog(repo,{reader}),importer:createCityImporter(repo,{fetchJson:cityFetchJson}),maps,browserMap:async()=>({available:false}),postingEnabled}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,{actor='field_sales',body,method=body?'POST':'GET'}={})=>fetch(base+'/api/field-sales'+path,{method,headers:{'Content-Type':'application/json',...(actor?{Authorization:`Bearer ${actors[actor].token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {actors,site,route,repo,maps,base,request,async close(){await new Promise(resolve=>server.close(resolve));await query('UPDATE field_sales_settings SET data=$1,revision=$2 WHERE singleton',[JSON.stringify(original.data),original.revision]);}};
}
