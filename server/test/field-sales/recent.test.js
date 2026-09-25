import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../src/db.js';
import {createFieldSalesRepository} from '../../src/field-sales/repository.js';
import {seedRecent} from './recent-fixture.js';
const now=new Date('2026-09-19T00:30:00Z'),repo=createFieldSalesRepository(undefined,{now:()=>now});let f;
before(async()=>{f=await seedRecent('2026-09-18');});after(closeDb);
const list=patch=>repo.listJobsites({search:f.prefix,source:'recommended',recencyMonths:'12',limit:200,...patch});
test('R1 old imports do not become fresh leads; omitted recency keeps unrestricted dates',async()=>{
  const current=await list(),ids=current.items.map(s=>s.id);
  for(const name of ['house','foundation','ready','approved','priority','atCutoff','buildingDrain','siteService','conditionalDrain','unclear']){assert.ok(ids.includes(f.ids[name]),name);}
  for(const name of ['oldDrain','oldHouse','undated','mixed','complete','badDate','beforeCutoff']){assert.ok(!ids.includes(f.ids[name]),name);}
  assert.ok((await list({recencyMonths:undefined})).items.some(s=>s.id===f.ids.oldHouse));
  assert.ok((await list({recencyMonths:'all',includeMinor:'true'})).items.some(s=>s.id===f.ids.oldDrain));
});
test('R2 date/status/category/work must match the same source record',async()=>{
  const inspection=await list({source:'permit',permitStatus:'Inspection'});
  assert.deepEqual(inspection.items.map(s=>s.id),[f.ids.foundation]);
  assert.equal((await list({source:'permit',permitStatus:'Inspection',category:'Demolition Folder (DM)'})).total,0);
  assert.equal((await list({source:'permit',category:'New Houses'})).items.some(s=>s.id===f.ids.mixed),false);
});
test('R3 service work opt-in restores records while construction-related work survives',async()=>{
  const basic=await list({source:'permit'}),all=await list({source:'permit',includeMinor:'true'});
  for(const name of ['newDrain','standaloneDrain','sign','solar','admin','useOnly','windowOnly']){assert.ok(!basic.items.some(s=>s.id===f.ids[name]),name);assert.ok(all.items.some(s=>s.id===f.ids[name]),name);}
  for(const name of ['house','buildingDrain','siteService','conditionalDrain']){assert.ok(basic.items.some(s=>s.id===f.ids[name]),name);}
});
test('R4 qualifying evidence supplies issue, application and milestone dates with priority/date ordering',async()=>{
  const rows=(await list()).items;assert.equal(rows[0].id,f.ids.priority);
  const house=rows.find(s=>s.id===f.ids.house);assert.equal(house.lead.date,'2026-09-17');assert.equal(house.lead.dateKind,'issued');assert.equal(house.lead.work,'New Building');
  assert.ok(rows.findIndex(s=>s.id===f.ids.house)<rows.findIndex(s=>s.id===f.ids.foundation));
  const ready=rows.find(s=>s.id===f.ids.ready);assert.equal(ready.lead.date,'2026-09-16');assert.equal(ready.lead.dateKind,'application');
  assert.equal(rows.find(s=>s.id===f.ids.approved).lead.dateKind,'milestone');assert.equal(rows.find(s=>s.id===f.ids.unclear).lead.needsReview,true);
  const mixed=(await list({includeMinor:'true'})).items.find(s=>s.id===f.ids.mixed);assert.equal(mixed.lead.category,'Plumbing');assert.equal(mixed.rank,35);
});
test('R5 malformed/missing dates are safe, and manual records do not require City dates',async()=>{
  const rows=(await list()).items;const fallback=rows.find(s=>s.id===f.ids.badIssued);assert.equal(fallback.lead.dateKind,'application');assert.equal(fallback.lead.date,'2026-09-13');
  const all=await list({recencyMonths:'all'});for(const name of ['undated','badDate']){assert.equal(all.items.find(s=>s.id===f.ids[name]).lead.date,null);}
  assert.deepEqual((await list({source:'manual'})).items.map(s=>s.id),[f.ids.manual]);assert.ok((await list({source:'all'})).items.some(s=>s.id===f.ids.manual));
  for(const value of ['0','13','-1','12 months',"12'); DROP TABLE field_sales_sources;--",['12','24']]){await assert.rejects(list({recencyMonths:value}),/recency/i);}
});
test('R6 complete-application milestones are found in planning and share map/list/bulk criteria',async()=>{
  const criteria={search:f.prefix,source:'planning',recencyMonths:'12',milestone:'Notice of Complete Application Issued',bounds:'-79.6,43.69,-79.55,43.73'};
  const rows=await repo.listJobsites(criteria),pins=await repo.mapJobsites({...criteria,zoom:18});assert.deepEqual(rows.items.map(s=>s.id),[f.ids.complete]);assert.equal(rows.items[0].lead.dateKind,'milestone');assert.equal(pins.reduce((sum,p)=>sum+p.count,0),rows.total);
  const bulk=await repo.listJobsites({...criteria,limit:200});assert.deepEqual(bulk.items.map(s=>s.id),rows.items.map(s=>s.id));
  const defaults=await list(),map=await repo.mapJobsites({search:f.prefix,source:'recommended',recencyMonths:'12'});assert.equal(map.reduce((sum,p)=>sum+p.count,0),defaults.total);
  const page1=await list({limit:2}),page2=await list({limit:2,offset:2});assert.deepEqual([...page1.items,...page2.items].map(s=>s.id),defaults.items.slice(0,4).map(s=>s.id));
});
test('R7 filtering leaves old site details and source timestamps intact',async()=>{
  const snapshot=(await query('SELECT last_seen_at,data FROM field_sales_sources WHERE jobsite_id=$1',[f.ids.oldDrain])).rows;
  await list();const site=await repo.getJobsite(f.ids.oldDrain);assert.equal(site.address,'276 PRINCE EDWARD DR S');assert.equal(site.sources[0].data.raw.PERMIT_NUM,'22 127851 DRN');
  assert.deepEqual((await query('SELECT last_seen_at,data FROM field_sales_sources WHERE jobsite_id=$1',[f.ids.oldDrain])).rows,snapshot);
});
