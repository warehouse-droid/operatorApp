import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { httpFixture } from './http-fixture.js';
import { closeDb,query } from '../../src/db.js';
let f;
before(async()=>{f=await httpFixture();});after(async()=>{if(f){await f.close();}await closeDb();});
test('H1 actual staff authentication permits only Field Sales/admin',async()=>{
  assert.equal((await f.request('/status',{actor:null})).status,401);
  assert.equal((await f.request('/status',{actor:'sales'})).status,403);
  assert.equal((await f.request('/status')).status,200);
  assert.equal((await f.request('/status',{actor:'admin'})).status,200);
  assert.equal((await f.request('/settings',{method:'PUT',body:{revision:1,data:{enabled:false}}})).status,403);
});
test('H2 malformed identities, SQL-like search, route ownership and stale edits',async()=>{
  const search=await f.request('/jobsites?search='+encodeURIComponent("' OR 1=1;--"));assert.equal(search.status,200);assert.equal((await search.json()).total,0);
  assert.equal((await f.request('/jobsites/not-a-uuid')).status,400);
  const route={...f.route.data,id:f.route.id,revision:0,name:'Stale',date:f.route.date};
  assert.equal((await f.request('/commands',{body:{id:randomUUID(),kind:'route.save',payload:route}})).status,409);
  assert.equal((await f.request('/commands',{body:{id:randomUUID(),kind:'route.save',payload:{...route,revision:1,ownerId:f.actors.admin.operator.id}}})).status,403);
});
test('H3 duplicate HTTP visit and photo preserve exactly one durable record',async()=>{
  const visitId=randomUUID(),body={id:randomUUID(),kind:'visit.record',payload:{id:visitId,jobsiteId:f.site.id,routeId:f.route.id,stopId:f.route.data.stops[0].id,outcome:'Quote requested',note:'Met foreman',observedStage:'Active construction',occurredAt:'2026-09-18T18:00:00Z',revisitDate:'2026-10-02',revisitPriority:3}};
  const responses=await Promise.all([f.request('/commands',{body}),f.request('/commands',{body})]);assert.deepEqual(responses.map(r=>r.status),[200,200]);
  const image=await sharp({create:{width:20,height:20,channels:3,background:'#668844'}}).png().toBuffer(),photo={id:randomUUID(),visitId,base64:image.toString('base64')};
  const uploads=await Promise.all([f.request('/photos',{body:photo}),f.request('/photos',{body:photo})]);assert.deepEqual(uploads.map(r=>r.status),[200,200]);
  const read=await f.request(`/photos/${photo.id}`);assert.equal(read.status,200);assert.equal(read.headers.get('content-type'),'image/jpeg');assert.ok((await read.arrayBuffer()).byteLength>100);
  assert.equal((await f.request(`/photos/${photo.id}`,{actor:'sales'})).status,403);
  assert.equal((await f.request('/photos',{body:{...photo,base64:Buffer.from('hostile input').toString('base64')}})).status,409);
  assert.equal((await f.request('/photos',{body:{...photo,id:randomUUID(),base64:'not an image'}})).status,400);
  const site=await (await f.request(`/jobsites/${f.site.id}`)).json();assert.equal(site.visits.length,1);assert.equal(site.visits[0].photos.length,1);
  assert.ok((await (await f.request('/followups')).json()).items.some(x=>x.visit_id===visitId&&x.priority===3));
});
test('H4 company quote HTTP totals/PDF and retired estimate guard',async()=>{
  const customerId=randomUUID();
  let r=await f.request('/commands',{body:{id:randomUUID(),kind:'customer.save',payload:{id:customerId,name:'Test Builder'}}});assert.equal(r.status,200);
  r=await f.request('/commands',{body:{id:randomUUID(),kind:'customer.link',payload:{customerId,jobsiteId:f.site.id}}});assert.equal(r.status,200);
  const id=randomUUID();const response=await f.request('/commands',{body:{id:randomUUID(),kind:'quote.save',payload:{id,company:'MBBS',jobsiteId:f.site.id,fieldSalesCustomerId:customerId,lines:[{id:'a',company:'MBBS',itemId:'92000001',description:'Block',quantity:'3',unitRate:'19.99'}]}}});assert.equal(response.status,200);assert.equal((await response.json()).quote.snapshot.totalMinor,6777);
  const pdf=await f.request(`/quotes/${id}/pdf?revision=1`);assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  const publish=await f.request('/commands',{body:{id:randomUUID(),kind:'quote.publish',payload:{id,revision:1}}});assert.equal(publish.status,409);assert.match((await publish.json()).error,/Sales Order|local/);
  const catalog=await (await f.request('/catalog?company=MBT&search=FS-BIN')).json();assert.equal(catalog.items[0].unit_rate,'100');
  assert.equal((await f.request('/catalog/price',{body:{company:'MBT',itemId:'92000002'}})).status,200);
  assert.equal((await f.request('/route-estimate',{body:{...f.route.data}})).status,200);
});
test('H5 disable gate stops direct writes and reads but retains admin setup access',async()=>{
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{enabled}','false')`);
  assert.equal((await f.request('/jobsites')).status,409);
  assert.equal((await f.request('/commands',{body:{id:randomUUID(),kind:'note.add',payload:{id:randomUUID(),jobsiteId:f.site.id,body:'blocked'}}})).status,409);
  assert.equal((await f.request('/status',{actor:'admin'})).status,200);
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{enabled}','true')`);
});

test('H6 new customer, template and evidence APIs enforce Field Sales and admin access',async()=>{
 for(const path of ['/customer-records','/customer-types']){assert.equal((await f.request(path,{actor:'sales'})).status,403);assert.equal((await f.request(path,{actor:null})).status,401);assert.equal((await f.request(path)).status,200);}
 assert.equal((await f.request('/template-preview',{body:{company:'MBBS'}})).status,403);
 const preview=await f.request('/template-preview',{actor:'admin',body:{company:'MBBS',profile:{name:'Preview only',visible:{signature:false}}}});assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'application/pdf');
 assert.equal((await f.request('/quote-evidence/'+randomUUID(),{actor:'sales'})).status,403);
 assert.equal((await f.request('/quote-evidence/'+randomUUID())).status,404);
});

test('H7 only admins can inspect read-only Sales Order integration readiness',async()=>{
 assert.equal((await f.request('/integration-status')).status,403);
 const result=await f.request('/integration-status',{actor:'admin'});assert.equal(result.status,200);
 const data=await result.json();assert.equal(data.serverEnabled,false);assert.equal(data.compatible,false);assert.equal(Array.isArray(data.missing),true);
});
