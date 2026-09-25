import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query,withTransaction,closeDb } from '../../src/db.js';
import { createFieldSalesRepository } from '../../src/field-sales/repository.js';

after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
async function fixture() {
  const actors={};
  for(const role of ['admin','field_sales']){
    const actor={id:randomUUID(),role};actors[role]=actor;
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,$1,'test','test',$2,ARRAY[$2])`,[actor.id,role]);
  }
  const repo=createFieldSalesRepository();
  const settings=await repo.settings();await repo.saveSettings(actors.admin,{revision:settings.revision,data:{enabled:true}});
  const cmd=(kind,payload,actor=actors.field_sales)=>repo.command(actor,{id:randomUUID(),kind,payload});
  return {repo,cmd,...actors};
}
test('A1 admin settings use revisions and reject unusable visit outcome lists',()=>withTransaction(async()=>{
  const f=await fixture(),settings=await f.repo.settings();
  await assert.rejects(f.repo.saveSettings(f.field_sales,{revision:settings.revision,data:{enabled:false}}),e=>e.status===403);
  await assert.rejects(f.repo.saveSettings(f.admin,{revision:0,data:{enabled:false}}),e=>e.status===409);
  for(const data of [{enabled:'yes'},{companies:{MBBS:{taxBps:-1}}},{outcomes:[]},{outcomes:['']},{outcomes:['Met',{}]},{outcomes:['Met','Met']}]){
    await assert.rejects(f.repo.saveSettings(f.admin,{revision:settings.revision,data}),e=>e.status===400);
  }
  const changed=await f.repo.saveSettings(f.admin,{revision:settings.revision,data:{outcomes:['Met superintendent','No access']}});
  assert.deepEqual(changed.data.outcomes,['Met superintendent','No access']);
  assert.equal(changed.revision,settings.revision+1);
},{rollback:true}));
test('R6 one active route per rep, admin reassignment and explicit follow-up completion',()=>withTransaction(async()=>{
  const f=await fixture(),site=(await f.cmd('jobsite.save',{id:randomUUID(),address:'1 Routing Street'})).jobsite;
  const base={id:randomUUID(),date:'2026-09-18',status:'active',stops:[{id:randomUUID(),jobsiteId:site.id,stayMinutes:20}],origin:{address:'Depot'},end:{address:'Office'}};
  const first=(await f.cmd('route.save',base)).route;
  assert.equal(first.data.windowEnd,'2026-09-18T21:00:00.000Z');assert.equal(first.data.end.address,'Office');
  await assert.rejects(f.cmd('route.save',{...base,id:randomUUID()}),/Pause your active route/);
  const reassigned=(await f.cmd('route.save',{...base,revision:first.revision,ownerId:f.admin.id},f.admin)).route;
  assert.equal(reassigned.owner_id,f.admin.id);
  await assert.rejects(f.cmd('route.save',{...base,revision:reassigned.revision}),e=>e.status===403);
  const visit=randomUUID();await f.cmd('visit.record',{id:visit,jobsiteId:site.id,outcome:'Contact unavailable',occurredAt:'2026-09-18T16:00:00Z',revisitDate:'2026-10-02',revisitPriority:3,location:{latitude:43.7,longitude:-79.4}});
  assert.equal((await f.repo.listFollowups(f.field_sales)).find(x=>x.id===visit).priority,3);
  assert.ok((await f.repo.listFollowups(f.admin)).some(x=>x.id===visit));
  await f.cmd('followup.complete',{id:visit});assert.ok(!(await f.repo.listFollowups(f.field_sales)).some(x=>x.id===visit));
  await assert.rejects(f.cmd('followup.complete',{id:randomUUID()}),e=>e.status===404);
  assert.ok((await f.repo.listRoutes(f.admin,'2026-09-18')).some(r=>r.id===base.id));
  assert.ok((await f.repo.listReps()).some(r=>r.id===f.field_sales.id));
  await assert.rejects(f.repo.getRoute(randomUUID()),e=>e.status===404);
},{rollback:true}));
test('R7 malformed edits fail without partial routes or visits',()=>withTransaction(async()=>{
  const f=await fixture(),site=(await f.cmd('jobsite.save',{id:randomUUID(),address:'2 Routing Street'})).jobsite;
  const base={id:randomUUID(),date:'2026-09-18',stops:[{id:randomUUID(),jobsiteId:site.id}]};
  for(const patch of [{ownerId:randomUUID()},{stops:null},{stops:[base.stops[0],base.stops[0]]},{stops:[{...base.stops[0],stayMinutes:-1}]},{status:'invalid'}]){
    await assert.rejects(f.cmd('route.save',{...base,...patch}),e=>e.status===400||e.status===403);
  }
  for(const patch of [{latitude:91},{longitude:-181},{observedStage:'Demolition?'},{priority:4}]){
    await assert.rejects(f.cmd('jobsite.save',{...site,...patch}),e=>e.status===400);
  }
  const visit={id:randomUUID(),jobsiteId:site.id,outcome:'Contact met',occurredAt:'2026-09-18T16:00:00Z'};
  for(const patch of [{outcome:'unexpected'},{occurredAt:'yesterday'},{observedStage:'invalid'},{routeId:randomUUID()},{revisitDate:'2026-02-30'}]){
    await assert.rejects(f.cmd('visit.record',{...visit,...patch}),e=>e.status===400||e.status===404);
  }
  assert.equal((await f.repo.getJobsite(site.id)).visits.length,0);
  await assert.rejects(f.cmd('unknown',{}),/Unknown Field Sales command/);
  await assert.rejects(f.repo.getJobsite(randomUUID()),e=>e.status===404);
},{rollback:true}));
test('R11 changing a jobsite address without new coordinates clears the previous map point',()=>withTransaction(async()=>{
  const f=await fixture(),site=(await f.cmd('jobsite.save',{id:randomUUID(),address:'1 Original Road',latitude:43.7,longitude:-79.5})).jobsite;
  const changed=(await f.cmd('jobsite.save',{id:site.id,revision:site.revision,address:'200 Different Road'})).jobsite;
  assert.equal(changed.address,'200 Different Road');assert.equal(changed.latitude,null);assert.equal(changed.longitude,null);
},{rollback:true}));
test('F1 district, ward, postal, evidence, map and follow-up filters use persisted data',()=>withTransaction(async()=>{
  const f=await fixture(),id=randomUUID(),site=(await f.cmd('jobsite.save',{id,name:id,address:'3 Filter Avenue',ward:'1',district:'Etobicoke-York',postalPrefix:'M9W',latitude:43.72,longitude:-79.57,priority:3,observedStage:'Active construction'})).jobsite;
  assert.equal(site.ward,'01');
  const source={address:'3A Filter Avenue',description:'Warehouse expansion',category:'Site Plan Approval',milestone:'Statement of Approval Issued',rank:30,minor:false,status:'Permit Issued'};
  await query(`INSERT INTO field_sales_sources(source,source_key,jobsite_id,address_key,data) VALUES('planning',$1,$2,'3 FILTER AVE',$3)`,[id,id,source]);
  assert.ok((await f.repo.facets()).milestones.includes(source.milestone));
  await f.cmd('visit.record',{id:randomUUID(),jobsiteId:id,outcome:'Quote requested',occurredAt:'2026-09-18T16:00:00Z',revisitDate:'2026-10-02'});
  const match={search:id,source:'recommended',district:'Etobicoke-York',ward:'01',postal:'m9w',priority:'2',stage:'Active construction',milestone:source.milestone,category:source.category,permitStatus:source.status,outcome:'Quote requested',revisitBefore:'2026-10-02',bounds:'-79.6,43.7,-79.5,43.8'};
  assert.equal((await f.repo.listJobsites(match)).total,1);
  for(const patch of [{postal:'M1X'},{bounds:'-80,42,-79.9,42.1'},{revisitBefore:'2026-10-01'},{priority:0,stage:'Completed'}]){assert.equal((await f.repo.listJobsites({...match,...patch})).total,0);}
  assert.equal((await f.repo.listJobsites({search:'3A Filter Avenue',source:'planning'})).items.some(s=>s.id===id),true);
  for(const zoom of [11,13,15,18]){const pins=await f.repo.mapJobsites({search:id,zoom});assert.equal(pins.length,1);assert.equal(pins[0].count,1);assert.equal(pins[0].id,id);}
  await assert.rejects(f.repo.listJobsites({bounds:'2,3,1,4'}),/Invalid map bounds/);
  await assert.rejects(f.repo.listJobsites({bounds:'x,y,z,w'}),/Invalid map bounds/);
  await f.cmd('jobsite.save',{...site,revision:(await f.repo.getJobsite(id)).revision,archived:true});
  assert.equal((await f.repo.listJobsites({search:id})).total,0);assert.equal((await f.repo.listJobsites({search:id,archived:'true',source:'manual'})).total,1);assert.equal((await f.repo.listJobsites({search:id,archived:'all'})).total,1);
},{rollback:true}));
