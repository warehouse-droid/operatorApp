import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {app} from '../src/server.js';
import {query,closeDb} from '../src/db.js';
import {replaceDispatchFleetSetup} from '../src/dispatch-setup-repository.js';
import {getDriverDayJobs} from '../src/driver-repository.js';
import {createDriverSession,recordDriverOfflinePhotoReceipts,markDriverOfflinePhotoDurable,getDriverOfflineEvent} from '../src/driver-offline-repository.js';
import {DRIVER_PWA_CURRENT_VERSION,DRIVER_PWA_VERSION_HEADER} from '../src/driver-client-version.js';
if(process.env.MBT_TEST_ISOLATED!=='1' || !process.env.DATABASE_URL.endsWith('/mbt_test_file_188188188188_driverflow')){throw new Error('Dedicated disposable Driver-flow database required.');}
const date=(await query("SELECT (now() AT TIME ZONE 'America/Toronto')::date::text AS day")).rows[0].day;
const drivers=['sor-flow-online','sor-flow-offline'];
await replaceDispatchFleetSetup({drivers:drivers.map(login=>({login,name:login,active:true,samsaraEnabled:false,license:'AZ',number:login})),trucks:drivers.map((_,index)=>({plate:`SOR-FLOW-${index}`,capacityLbs:40000,active:true}))},{activeOnly:false,deactivateMissing:false});
await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='driver_offline_mode'");
const orders=drivers.map((_,index)=>({id:`SOR9880040${index+1}`,type:'SO',customer:'Isolated signature customer',sourceYard:'3445',pickupLocations:['3445'],address:`${77+index} Isolated Site Road`,items:[{itemId:98800400+index,itemName:'Lift/Day',itemType:'Service',quantity:1}]}));
const trucks=drivers.map((login,index)=>({id:`sor-truck-${index}`,plate:`SOR-FLOW-${index}`,base:'3445',driverLogin:login,loads:[{id:`sor-load-${index}`,name:'SOR signature test',driverLogin:login,stops:[{id:`sor-stop-${index}`,type:'drop',orderId:orders[index].id,location:orders[index].address}]}]}));
const plan=(await query("INSERT INTO dispatch_plans(plan_date,status,revision,confirmed_at) VALUES($1,'confirmed',1,now()) RETURNING id",[date])).rows[0];
await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[plan.id,JSON.stringify(orders),JSON.stringify(trucks)]);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const result=[];
try {
 for(const [index,login] of drivers.entries()){
  const route=await getDriverDayJobs(login,{date});
  const drop=route.jobs.find(job=>job.stopType==='dropoff');assert.ok(drop);
  for(const job of route.jobs){
   await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,stop_id,stop_type,order_refs,status,started_at,completed_at,job_details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()-interval '1 minute',CASE WHEN $12='complete' THEN now()-interval '30 seconds' ELSE null END,$13)`,
   [job.jobId,plan.id,date,login,job.truckId,job.truckPlate,job.loadId,job.loadName,job.stopId,job.stopType,JSON.stringify(job.orderRefs||[]),job.jobId===drop.jobId?'in_progress':'complete',JSON.stringify(job)]);
  }
  const deviceId=crypto.randomUUID();const auth=await createDriverSession(login,{deviceId});
  const headers={authorization:`Bearer ${auth.token}`,'content-type':'application/json','x-mbbs-driver-device':deviceId,[DRIVER_PWA_VERSION_HEADER]:DRIVER_PWA_CURRENT_VERSION};
  async function request(path,body,grant=''){
   const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...headers,...(grant?{'x-mbbs-offline-grant':grant}:{})},...(body?{body:JSON.stringify(body)}:{})});
   const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));return payload;
  }
  const signature={photoId:crypto.randomUUID(),termsRevision:drop.customerSignaturePrompt.revision,capturedAt:new Date().toISOString(),signedBy:'Test customer'};
  if(index===0){
   const image='data:image/jpeg;base64,/9j/2Q==';
   await request(`/api/driver/jobs/${encodeURIComponent(drop.jobId)}/photos`,{photoDataUrls:[image,image],locationOverride:true,customerSignature:{...signature,imageDataUrl:image}});
  }else{
   const manifest=await request(`/api/driver/day-plan?date=${date}&forceRefresh=1`);
   const job=manifest.jobs.find(row=>row.jobId===drop.jobId);assert.ok(job);
   const eventId=crypto.randomUUID();
   const photos=[0,1,900].map(ordinal=>{const bytes=Buffer.from('isolated-sor-evidence-'+ordinal);return {photoId:ordinal===900?signature.photoId:crypto.randomUUID(),ordinal,recordType:ordinal===900?'driver-customer-signature':'driver-stop-photo',mimeType:'image/jpeg',byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};});
   await request('/api/driver/offline-sync',{manifestId:manifest.manifestId,deviceId,offlineSyncGrant:manifest.offlineSyncGrant,events:[{eventId,clientSequence:1,eventType:'job_completed',jobId:job.jobId,jobFingerprint:job.fingerprint,predecessorFingerprint:job.predecessorFingerprint,occurredAt:new Date().toISOString(),locationStatus:'not_checked_offline',details:{customerSignature:signature},photos}],photoReceipts:[]},manifest.offlineSyncGrant);
   const receipts=photos.map(photo=>({...photo,objectReference:`r2://driver/${photo.recordType}/${date.replaceAll('-','/')}/${photo.photoId}/evidence.jpg`}));
   await assert.rejects(recordDriverOfflinePhotoReceipts({driverLogin:login,deviceId,manifestId:manifest.manifestId,photoReceipts:[{...receipts[2],objectReference:'r2://driver/driver-customer-signature/unrelated.jpg'}]}),error=>error.code==='OFFLINE_PHOTO_SCOPE_INVALID');
   await recordDriverOfflinePhotoReceipts({driverLogin:login,deviceId,manifestId:manifest.manifestId,photoReceipts:receipts});
   for(const receipt of receipts){await markDriverOfflinePhotoDurable(receipt.photoId,{objectReference:receipt.objectReference,verifiedByteSize:receipt.byteSize,verifiedSha256:receipt.sha256,receipt:{provider:'isolated-readback-proof'}});}
   await request('/api/driver/offline-sync',{manifestId:manifest.manifestId,deviceId,offlineSyncGrant:manifest.offlineSyncGrant,events:[],photoReceipts:[]},manifest.offlineSyncGrant);
   const applied=await getDriverOfflineEvent(eventId);assert.equal(applied.status,'applied',JSON.stringify(applied));
  }
  const saved=(await query('SELECT status,photo_data_urls,job_details FROM driver_job_records WHERE job_id=$1',[drop.jobId])).rows[0];
  assert.equal(saved.status,'complete');assert.equal(saved.photo_data_urls.length,2);
  assert.equal(saved.job_details.customerSignature.photoId,signature.photoId);
  assert.equal(saved.job_details.customerSignature.terms,drop.customerSignaturePrompt.terms);
  result.push({mode:index===0?'online':'offline',signed:true,deliveryPhotos:2,originalTerms:true});
 }
 writeFileSync('test-artifacts/sor-rentals/driver-flow-result.json',JSON.stringify({passed:true,result}));
 console.log(JSON.stringify({passed:true,result}));
} finally {await new Promise(resolve=>server.close(resolve));await closeDb();}
