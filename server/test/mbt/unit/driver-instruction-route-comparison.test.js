import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../../public/driver.js',import.meta.url),'utf8');
const start=source.indexOf('function stableComparableValue(');
const end=source.indexOf('const DRIVER_ROUTE_RECONCILIATION',start);
const compare=vm.runInNewContext(source.slice(start,end)+'\n(job)=>JSON.stringify(comparableJobDetails(job))');
const identityEnd=source.indexOf('function localCompletionReconciliationStatus(',start);
const sameStop=vm.runInNewContext('const manifestJobFor=()=>null;\n'+source.slice(start,identityEnd)+'\nsameLocationVerificationStop');
const job={jobId:'delivery-1',orderRefs:['SOB001'],address:'77 Site Road',
 deliveryInstructions:{revision:3,orders:[{orderRef:'SOB001',automaticText:'Use gate B',additionalText:'Call on arrival',phones:[{href:'+14165550100'}],media:[{id:5}]}]}};

test('local instruction translations do not change the authoritative stop comparison',()=>{
 const localized=structuredClone(job);
 localized.deliveryInstructions.orders[0].localized={language:'zh',automaticText:'Translated instructions',additionalText:'Translated note',automaticStatus:'translated'};
 assert.equal(compare(localized),compare(job));
 assert.ok(localized.deliveryInstructions.orders[0].localized,'Comparison must not mutate display data');
});
test('real instruction, reference, address, media and revision changes still require route review',()=>{
 for(const mutate of [
  value=>{value.address='99 New Site';},
  value=>{value.orderRefs=['SOB002'];},
  value=>{value.deliveryInstructions.revision++;},
  value=>{value.deliveryInstructions.orders[0].automaticText='Use gate C';},
  value=>{value.deliveryInstructions.orders[0].additionalText='Do not unload';},
  value=>{value.deliveryInstructions.orders[0].phones=[];},
  value=>{value.deliveryInstructions.orders[0].media=[{id:6}];}
 ]){const changed=structuredClone(job);mutate(changed);assert.notEqual(compare(changed),compare(job));}
 assert.equal(compare({}),compare({deliveryInstructions:{revision:0,orders:[]}}));
});
test('location verification survives an unchanged stop refresh and clears for another or edited stop',()=>{
 assert.equal(sameStop(job,structuredClone(job)),true);
 assert.equal(sameStop({...job,status:'in_progress'},{...job,status:'pending'}),true);
 assert.equal(sameStop(job,{...job,jobId:'another-stop'}),false);
 assert.equal(sameStop(job,{...job,address:'A different site'}),false);
 assert.equal(sameStop({...job,fingerprint:'old'},{...job,fingerprint:'new'}),false);
 assert.equal(sameStop(job,null),false);assert.equal(sameStop(null,job),false);
});

async function validateDuringCompletion({changed=false,review=false,otherDevice=false}={}){
 const pickup={...job,jobId:'pickup-1',status:'in_progress'};
 const expected={...job,status:'pending'};
 const latest=changed?{...expected,address:'Dispatch changed the address'}:expected;
 const manifest={manifestId:'route-1',jobs:[pickup,expected]};
 const replies=[{job:pickup},{job:latest,pendingCompletion:otherDevice?{eventType:'job_completed',status:'waiting_photos',jobId:expected.jobId}:null}];
 let requests=0;
 const context={
  navigator:{onLine:true},driver:{},authToken:'fixture',driverOfflineModeEnabled:true,
  offlineStorageAvailable:true,offlinePartition:{partitionKey:'fixture'},offlineManifest:manifest,
  savedRouteClearRunning:false,onlineRouteValidationPromise:null,activeRest:null,currentJob:expected,
  onlineRouteLastValidatedAt:0,onlineRouteUpdatePending:false,onlineRouteRevalidationQueued:false,
  offlineStatus:{dataset:{}},dayState:{},
  manifestJobFor:id=>manifest.jobs.find(value=>value.jobId===id),jobIsComplete:value=>value.status==='complete',
  request:async()=>{requests++;assert.ok(replies.length,'Revalidation must be bounded');return replies.shift();},
  fetchDriverDayPlanPayload:async()=>manifest,manifestPlanDate:()=>null,localDate:()=> '2026-09-24',
  manifestRevisionChanged:()=>false,incomingRouteDiffers:()=>false,
  window:{DriverOfflineDB:{getProjectionEvents:async()=>[{eventType:'job_completed',jobId:pickup.jobId,status:review?'review_required':'applied'}]}},
  saveDriverDayPlanPayload:async()=>({activate:true}),photoInteractionActive:()=>false,
  renderOfflineStatus:()=>{},loadNextJob:async()=>{},scheduleOnlineRouteRevalidation:()=>{},showToast:()=>{},
  t:(_key,fallback)=>fallback,tf:(_key,fallback)=>fallback,localizeMessage:value=>value,isGenuineNetworkFailure:async()=>false
 };
 const comparisonSource=source.slice(source.indexOf('function withManifestJobIdentity('),source.indexOf('function jobEventRequiresManifestIdentity(',start));
 const validationSource=source.slice(source.indexOf('async function revalidateOnlineRoute('),source.indexOf('async function flushQueuedOnlineRouteRevalidation('));
 const revalidate=vm.runInNewContext(comparisonSource+'\n'+validationSource+'\nrevalidateOnlineRoute',context);
 return {allowed:await revalidate({beforeAction:true,expectedJob:expected}),requests};
}
test('starting the next stop survives completion applying during the server check',async()=>{
 assert.deepEqual(await validateDuringCompletion(),{allowed:true,requests:2});
});
test('a fresh route edit, review or other-device evidence still blocks the action',async()=>{
 assert.equal((await validateDuringCompletion({changed:true})).allowed,false);
 assert.deepEqual(await validateDuringCompletion({review:true}),{allowed:false,requests:1});
 assert.equal((await validateDuringCompletion({otherDevice:true})).allowed,false);
});

test('a next-stop start uses the ordered ledger while predecessor photos are pending',()=>{
 const pickup={...job,jobId:'pickup-1',status:'in_progress'};
 const current={...job,status:'pending'};
 const later={...job,jobId:'later-1',status:'pending'};
 const manifest={manifestId:'route-1',jobs:[pickup,current,later]};
 const context={manifestJobFor:(id,route)=>route.jobs.find(value=>value.jobId===id),jobIsComplete:value=>value.status==='complete'};
 const functions=source.slice(start,source.indexOf('function jobEventRequiresManifestIdentity(',start));
 const defer=vm.runInNewContext(functions+'\ntypeof jobStartWaitsForLocalCompletions === "function" ? jobStartWaitsForLocalCompletions : ()=>false',context);
 const event={eventType:'job_completed',jobId:pickup.jobId,status:'waiting_photos'};
 for(const status of ['pending','waiting_photos','receipt_pending','syncing']){
  assert.equal(defer(current,manifest,[{...event,status}]),true,status);
 }
 for(const status of ['applied','cancelled']){
  assert.equal(defer(current,manifest,[{...event,status}]),false,status);
 }
 assert.equal(defer(current,manifest,[{...event,jobId:later.jobId}]),false);
 assert.equal(defer(current,manifest,[{...event,jobId:'another-route'}]),false);
 assert.equal(defer(current,manifest,[]),false);
});

test('known offline state keeps sync recovery from covering usable route controls',()=>{
 const holdSource=source.slice(source.indexOf('function requestQuietSyncHold('),source.indexOf('function beginQuietSync('));
 for(const [online,observed,expected] of [[true,true,false],[false,false,false],[true,false,true]]){
  let inert=false;
  const context={navigator:{onLine:online},browserOfflineObserved:observed,quietSyncEpoch:1,
   quietSyncActive:()=>true,quietSyncHoldLatched:false,quietSyncRestoreFocus:null,
   document:{activeElement:null,body:{classList:{add:()=>{}}}},HTMLElement:class {},
   setQuietSyncBackgroundInert:value=>{inert=value;},quietSyncHoldTimer:null,
   window:{setTimeout:()=>1},syncHold:{hidden:true},displayQuietSyncHold:()=>{}};
  const hold=vm.runInNewContext(holdSource+'\nrequestQuietSyncHold',context);
  hold({epoch:1});assert.equal(inert,expected,JSON.stringify({online,observed}));
 }
});
