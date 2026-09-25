import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { httpFixture } from './http-fixture.js';
import { closeDb,query } from '../../src/db.js';
let f;
before(async()=>{f=await httpFixture({cityFetchJson:async u=>u.includes('returnCountOnly')?{count:1}:u.includes('/query')?{features:[{attributes:{OBJECTID:1,FOLDERRSN:986000001,PROPERTYRSN:1,APPLICATION_TYPE:'Community planning',STATUS_GROUP:'Open',FULL_ADDRESS:'986 HTTP Test Road'}}]}:{editingInfo:{lastEditDate:1}},transport:async()=>({unitRate:'19.99',unit:'Each',unitId:'1'})});});
after(async()=>{if(f){await f.close();}await closeDb();});
test('H6 admin setup and read endpoints remain available through actual authentication',async()=>{
  const settings=(await (await f.request('/status')).json()).settings;
  const response=await f.request('/settings',{actor:'admin',method:'PUT',body:{revision:settings.revision,data:{enabled:true}}});assert.equal(response.status,200);assert.equal((await response.json()).revision,settings.revision+1);
  for(const path of ['/facets','/reps','/routes?date=2026-09-18',`/routes/${f.route.id}`,'/quotes','/customers?search=missing','/imports','/map?source=manual&zoom=18']){assert.equal((await f.request(path)).status,200,path);}
  assert.equal((await f.request('/map-session',{body:{sessionId:'test'}})).status,200);
  const stops=[{id:'far',latitude:43.8,longitude:-79.5},{id:'near',latitude:43.71,longitude:-79.5}];
  const order=await f.request('/route-order',{body:{stops,origin:{latitude:43.7,longitude:-79.5}}});assert.deepEqual((await order.json()).stops.map(s=>s.id),['near','far']);
  assert.equal((await f.request('/route-order',{body:{stops:'bad'}})).status,400);
  assert.equal((await f.request('/catalog/refresh',{body:{}})).status,403);
  assert.equal((await f.request('/catalog/price',{body:{company:'MBBS',itemId:'92000001'}})).status,200);
});
test('H7 geocoding uses known City coordinates and returns actionable unavailable results',async()=>{
  await query(`INSERT INTO field_sales_addresses(address_key,latitude,longitude,ward,ward_name,district) VALUES('986 HTTP TEST RD',43.71,-79.51,'01','Test','Etobicoke-York') ON CONFLICT DO NOTHING`);
  let response=await f.request('/locate',{body:{address:'986 HTTP Test Road'}});assert.equal(response.status,200);assert.equal((await response.json()).latitude,43.71);
  response=await f.request('/locate',{body:{address:'Unlisted road'}});assert.equal(response.status,200);assert.equal((await response.json()).latitude,43.7);
  const geocode=f.maps.geocode;try{f.maps.geocode=async()=>null;assert.equal((await f.request('/locate',{body:{address:'No coordinates'}})).status,409);}finally{f.maps.geocode=geocode;}
  assert.equal((await f.request('/locate',{body:{address:''}})).status,400);
});
test('H8 admin import starts asynchronously, finishes with durable history and refuses other roles',async()=>{
  assert.equal((await f.request('/imports/planning',{body:{}})).status,403);
  assert.equal((await f.request('/imports/unknown',{actor:'admin',body:{}})).status,400);
  const response=await f.request('/imports/planning',{actor:'admin',body:{}});assert.equal(response.status,202);
  let complete=false;
  for(let i=0;i<100;i++){const runs=(await (await f.request('/imports')).json()).items;if(runs.some(r=>r.source==='planning'&&r.state==='complete')){complete=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(complete);assert.ok((await f.repo.listJobsites({source:'planning',search:'986 HTTP'})).total>=1);
  assert.equal((await f.request('/catalog/refresh',{actor:'admin',body:{}})).status,200);
});
test('H9 photo validation handles real nonimages, missing visits and actor ownership',async()=>{
  const visitId=randomUUID(),visit={id:visitId,jobsiteId:f.site.id,outcome:'Contact met',occurredAt:'2026-09-18T12:00:00Z'};
  assert.equal((await f.request('/commands',{actor:'admin',body:{id:randomUUID(),kind:'visit.record',payload:visit}})).status,200);
  const png=(await sharp({create:{width:5,height:5,channels:3,background:'#333333'}}).png().toBuffer()).toString('base64');
  assert.equal((await f.request('/photos',{body:{id:randomUUID(),visitId,base64:png}})).status,403);
  assert.equal((await f.request('/photos',{body:{id:randomUUID(),visitId:randomUUID(),base64:png}})).status,409);
  assert.equal((await f.request('/photos',{actor:'admin',body:{id:randomUUID(),visitId,base64:Buffer.from('not image bytes').toString('base64')}})).status,400);
  assert.equal((await f.request(`/photos/${randomUUID()}`)).status,404);
  const id=randomUUID(),body={id,visitId,base64:png};assert.equal((await f.request('/photos',{actor:'admin',body})).status,200);assert.equal((await f.request('/photos',{actor:'admin',body})).status,200);
  assert.equal((await f.request('/photos',{body})).status,409);
  assert.equal((await f.request(`/quotes/${randomUUID()}/reconciliation`)).status,403);
  assert.equal((await f.request(`/quotes/${randomUUID()}/reconciliation`,{actor:'admin'})).status,409);
});
