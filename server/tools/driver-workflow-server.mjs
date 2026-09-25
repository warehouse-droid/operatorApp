// Isolated browser fixture host. This file is never copied into a release image.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {app} from '../src/server.js';
import {query} from '../src/db.js';
import {replaceDispatchFleetSetup} from '../src/dispatch-setup-repository.js';
import {getDriverDayJobs} from '../src/driver-repository.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(process.env.DATABASE_URL,'postgres://workflow:workflow_test_only@db:5432/driver_pwa_workflow');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
assert.equal(Number((await query('SELECT count(*) FROM dispatch_plans')).rows[0].count),0,'Fresh disposable database required');
const date=(await query("SELECT (now() AT TIME ZONE 'America/Toronto')::date::text AS day")).rows[0].day;
const drivers=['workflow-online','workflow-offline'];
await replaceDispatchFleetSetup({drivers:drivers.map(login=>({login,name:login,password:'isolated-workflow',active:true,samsaraEnabled:false})),
 trucks:drivers.map((_,i)=>({plate:`WORKFLOW-${i}`,baseYard:'3445',capacityLbs:40000,active:true}))},{activeOnly:false,deactivateMissing:false});
await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='driver_offline_mode'");
await query("UPDATE sor_signature_settings SET terms='I acknowledge receipt of the equipment listed for this delivery. Please record any concerns with the driver.',revision=revision+1 WHERE singleton");
await query('INSERT INTO sor_signature_terms_history SELECT revision,terms,updated_at,updated_by FROM sor_signature_settings');
const orders=[];const trucks=[];
for(const [index,login] of drivers.entries()){
 const refs=index===0?['SOB99881001','SOR99881002','SOR99881003']:['SOB99882001','SOR99882002'];
 const selected=refs.map((id,n)=>({id,type:'SO',customer:'Isolated workflow customer',sourceYard:'3445',pickupLocations:['3445'],
  sourceAddress:'3445 Kennedy Road, Scarborough, ON',address:`${77+n} Isolated Customer Road, Toronto, ON`,
  items:[{itemId:9988100+index*10+n,itemName:id.startsWith('SOR')?'Lift/Day':'Concrete block',itemType:id.startsWith('SOR')?'Service':'InvtPart',quantity:1,pallets:id.startsWith('SOR')?0:1}]}));
 orders.push(...selected);
 trucks.push({id:`workflow-truck-${index}`,plate:`WORKFLOW-${index}`,base:'3445',driverLogin:login,
  loads:[{id:`workflow-load-${index}`,name:'Workflow check',driverLogin:login,
   stops:[{id:`workflow-pick-${index}`,type:'pick',location:'3445',orderIds:refs},
    ...selected.map((order,n)=>({id:`workflow-drop-${index}-${n}`,type:'drop',orderId:order.id,location:order.address}))]}]});
}
const plan=(await query("INSERT INTO dispatch_plans(plan_date,status,revision,confirmed_at,note) VALUES($1,'confirmed',1,now(),'Isolated browser workflow') RETURNING id",[date])).rows[0];
await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[plan.id,JSON.stringify(orders),JSON.stringify(trucks)]);
const routes={};for(const login of drivers){routes[login]=(await getDriverDayJobs(login,{date})).jobs.map(job=>({jobId:job.jobId,stopType:job.stopType,refs:job.orderRefs,requiredPhotos:job.requiredPhotos}));}

// Simulate only the external object-store boundary, retaining actual upload
// tickets, byte/hash checks, durable readback, event processing and history APIs.
const objects=new Map();const storeStats={uploads:0,reads:0};
const secret=process.env.PHOTO_UPLOAD_TOKEN_SECRET;
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
const store=http.createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:3000');
 res.setHeader('Access-Control-Allow-Headers','authorization,content-type,x-file-name');
 res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 try{
  const parts=String(req.headers.authorization||'').replace(/^Bearer /,'').split('.');
  assert.equal(parts.length,3);
  assert.equal(parts[2],crypto.createHmac('sha256',secret).update(parts[0]+'.'+parts[1]).digest('base64url'));
  const claims=JSON.parse(Buffer.from(parts[1],'base64url'));
  assert.ok(claims.exp>Date.now()/1000);
  const url=new URL(req.url,'http://127.0.0.1:3101');
  if(req.method==='POST'&&url.pathname==='/upload'){
   assert.equal(claims.scope,'photo-upload');
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   let body=Buffer.concat(chunks);let type=req.headers['content-type']||'image/jpeg';
   if(type.startsWith('multipart/form-data')){
    const form=await new Response(body,{headers:{'content-type':type}}).formData();
    const file=form.get('file');body=Buffer.from(await file.arrayBuffer());type=file.type;
   }
   assert.ok(body.length&&body.length<=claims.maxBytes);
   const key=claims.keyPrefix+'/'+crypto.randomUUID()+'.jpg';
   objects.set(key,{body,type});storeStats.uploads++;
   json(res,200,{key,objectReference:'r2://'+key,byteSize:body.length});return;
  }
  assert.equal(claims.scope,'photo-read');assert.equal(claims.key,url.searchParams.get('key'));
  const saved=objects.get(claims.key);if(!saved){json(res,404,{error:'Object not found'});return;}
  storeStats.reads++;res.writeHead(200,{'content-type':saved.type,'content-length':saved.body.length});res.end(saved.body);
 }catch(error){json(res,400,{error:error.message});}
});
const control=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:3102');
  if(url.pathname==='/mode'&&req.method==='POST'){
   await query("UPDATE mbt_feature_flags SET enabled=$1,updated_at=now() WHERE flag_key='driver_offline_mode'",[url.searchParams.get('offline')==='true']);
  }
  const records=(await query("SELECT job_id,driver_login,stop_type,status,jsonb_array_length(photo_data_urls) AS photos,job_details->'customerSignature' AS signature FROM driver_job_records ORDER BY id")).rows;
  const events=(await query('SELECT driver_login,event_type,status,review_reason FROM driver_offline_events ORDER BY server_received_at')).rows;
  json(res,200,{date,routes,records,events,storeStats});
 }catch(error){json(res,500,{error:error.message});}
});
await Promise.all([new Promise(resolve=>store.listen(3101,'0.0.0.0',resolve)),new Promise(resolve=>control.listen(3102,'0.0.0.0',resolve)),new Promise(resolve=>app.listen(3000,'0.0.0.0',resolve))]);
console.log(JSON.stringify({ready:true,date,routes}));
