import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { query,withTransaction,closeDb } from '../../src/db.js';
import { createFieldSalesRepository } from '../../src/field-sales/repository.js';
import { createCityImporter,cityJson,readPlanningPages,readCkanPages } from '../../src/field-sales/importer.js';
import { normalizePermit } from '../../public/field-sales/domain.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
const collect=async pages=>{const rows=[];for await(const page of pages){rows.push(...page);}return rows;};
test('I5 active structure permits stay visible and missing addresses retain separate stable identities',()=>{
  const p={PERMIT_NUM:'26-001',REVISION_NUM:'00',PERMIT_TYPE:'Designated Structures',STATUS:'Inspection'};
  const normalized=normalizePermit(p);assert.equal(normalized.minor,false);assert.equal(normalized.sourceKey,'26-001:00::');
  assert.notEqual(normalized.groupKey,normalizePermit({...p,PERMIT_NUM:'26-002'}).groupKey);
  for(const category of ['Mechanical','Plumbing','Fire/Security','Signs']){assert.equal(normalizePermit({...p,PERMIT_TYPE:category}).minor,true);}
});
test('I6 authoritative coordinates refresh; ambiguous address matches do not imply a site location',()=>withTransaction(async()=>{
  let source='planning',latitude=43.7;
  const raw={OBJECTID:1,FOLDERRSN:980000001,PROPERTYRSN:1,FULL_ADDRESS:'98 Fixture Road',APPLICATION_TYPE:'Community planning',STATUS_GROUP:'Open',DISTRICT_NAME:'West',WARD_NUMBER:'1',LATITUDE:latitude,LONGITUDE:-79.5};
  const feeds={
    addresses:[{_id:1,ADDRESS_POINT_ID:1,ADDRESS_FULL:'98 Fixture Road',MUNICIPALITY_NAME:'former Toronto',WARD:10,WARD_NAME:'Spadina',geometry:JSON.stringify({type:'Point',coordinates:[-79.5,43.7]})},{_id:2,ADDRESS_POINT_ID:2,ADDRESS_FULL:'99 Fixture Road',geometry:{type:'Point',coordinates:[-79.5,43.7]}},{_id:3,ADDRESS_POINT_ID:3,ADDRESS_FULL:'99 Fixture Road',geometry:{type:'Point',coordinates:[-79.4,43.8]}},{_id:4,ADDRESS_POINT_ID:4,ADDRESS_FULL:'Bad Geometry',geometry:'invalid'}],
    permits:[{_id:1,PERMIT_NUM:'FS-P-1',STREET_NUM:'98',STREET_NAME:'Fixture',STREET_TYPE:'Road',PERMIT_TYPE:'New Building',STATUS:'Inspection'},{_id:2,PERMIT_NUM:'FS-P-2',STREET_NUM:'99',STREET_NAME:'Fixture',STREET_TYPE:'Road',PERMIT_TYPE:'Plumbing',STATUS:'Permit Issued'}],
    postal:[{_id:1,FOLDERRSN:raw.FOLDERRSN,STREET_NUM:'98',STREET_NAME:'Fixture',STREET_TYPE:'Road',POSTAL:'m5v'}]
  };
  const fetchJson=async target=>{const u=new URL(target);if(source==='planning'){if(u.searchParams.has('returnCountOnly')){return {count:1};}return u.pathname.endsWith('/query')?{features:[{attributes:{...raw,LATITUDE:latitude}}]}:{editingInfo:{lastEditDate:1}};}return u.pathname.endsWith('resource_show')?{result:{metadata_modified:'stable'}}:{result:{total:feeds[source].length,records:feeds[source]}};};
  const repo=createFieldSalesRepository(),importer=createCityImporter(repo,{fetchJson});
  await importer.run(source);latitude=43.73;await importer.run(source);
  const planning=(await query(`SELECT * FROM field_sales_jobsites WHERE source_group='planning:980000001'`)).rows[0];assert.equal(planning.latitude,43.73);
  source='addresses';await importer.run(source);source='permits';await importer.run(source);source='postal';await importer.run(source);
  const permit=(await query(`SELECT * FROM field_sales_jobsites WHERE source_group='address:98 FIXTURE RD'`)).rows[0];assert.equal(permit.district,'Toronto and East York');assert.equal(permit.ward,'10');assert.equal(permit.latitude,43.7);
  const ambiguous=(await query(`SELECT * FROM field_sales_jobsites WHERE source_group='address:99 FIXTURE RD'`)).rows[0];assert.equal(ambiguous.latitude,null);
  const detail=await repo.getJobsite(planning.id);assert.equal(detail.postal_prefix,'M5V');assert.equal(detail.addressEvidence.length,1);assert.equal(detail.addressEvidence[0].source,'permit');
  assert.equal((await repo.listJobsites({source:'permit',search:'99 Fixture'})).total,0);assert.equal((await repo.listJobsites({source:'permit',search:'99 Fixture',includeMinor:'true'})).total,1);
},{rollback:true}));
test('I7 scheduler gates, retry history and expired import leases keep the previous complete data',()=>withTransaction(async()=>{
  await query('DELETE FROM field_sales_import_stage');await query('DELETE FROM field_sales_import_runs');
  const repo=createFieldSalesRepository();let calls=0;
  const importer=createCityImporter(repo,{fetchJson:async()=>{calls++;throw new Error('City network interrupted');}});
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{importsEnabled}','false')`);await importer.tick();assert.equal(calls,0);
  await query(`UPDATE field_sales_settings SET data=data||'{"enabled":true,"importsEnabled":true}'::jsonb`);
  const stale=randomUUID();await query(`INSERT INTO field_sales_import_runs(id,source,started_at) VALUES($1,'permits',now()-interval '3 hours')`,[stale]);
  await assert.rejects(importer.tick(),/City network interrupted/);
  const history=await importer.history();assert.ok(history.some(r=>r.id===stale&&r.state==='failed'&&r.error.includes('interrupted')));assert.ok(history.some(r=>r.source==='planning'&&r.state==='failed'));
  await assert.rejects(importer.run('not-a-feed'),/Unknown City/);
  const running=randomUUID();await query(`INSERT INTO field_sales_import_runs(id,source) VALUES($1,'addresses')`,[running]);
  assert.equal((await importer.run('addresses')).state,'already_running');
  await query(`INSERT INTO field_sales_import_runs(id,source,state) VALUES($1,'postal','complete')`,[randomUUID()]);
  await importer.tick();assert.equal(calls,1);
},{rollback:true}));
test('I8 public JSON adapter detects HTTP/API failures and malformed pages',async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/http'){res.statusCode=503;res.end('{}');}else{res.end(req.url==='/error'?'{"success":false}':'{"count":1}');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{assert.deepEqual(await cityJson(base),{count:1});await assert.rejects(cityJson(base+'/http'),/HTTP 503/);await assert.rejects(cityJson(base+'/error'),/API error/);}finally{await new Promise(resolve=>server.close(resolve));}
  for(const count of [0,-1,1000001,'2']){await assert.rejects(collect(readPlanningPages({fetchJson:async()=>({count})})),/Unexpected planning count/);}
  await assert.rejects(collect(readPlanningPages({fetchJson:async u=>u.includes('returnCountOnly')?{count:1}:u.includes('/query')?{features:[{attributes:{}}]}:{}})),/Duplicate planning page identity/);
  await assert.rejects(collect(readCkanPages('x',{fetchJson:async()=>({result:{total:0}})})),/Unexpected City dataset size/);
  await assert.rejects(collect(readCkanPages('x',{fetchJson:async()=>({result:{total:2,records:[]}})})),/incomplete/);
  let metadata=0;await assert.rejects(collect(readCkanPages('x',{fields:['_id'],fetchJson:async u=>u.includes('resource_show')?{result:{metadata_modified:metadata++}}:{result:{total:1,records:[{_id:1}]}}})),/dataset changed/);
});
