// Real API and browser actions against the disposable copy only.
import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { readFileSync,writeFileSync,mkdirSync } from "node:fs";
import http from "node:http";
import { chromium } from "@playwright/test";
import { query,closeDb } from "../src/db.js";
import { config } from "../src/config.js";
import { createOperator,loginOperator } from "../src/auth-repository.js";
import { getDeliveryOrder } from "../src/delivery-repository.js";
import { getDispatchPlan } from "../src/dispatch-plan-repository.js";
import { getDriverDayJobs } from "../src/driver-repository.js";
import { DRIVER_PWA_CURRENT_VERSION,DRIVER_PWA_VERSION_HEADER } from "../src/driver-client-version.js";
import { app } from "../src/server.js";

assert.equal(process.env.MBT_TEST_ISOLATED,"1","PWA replay requires the isolated test runner");
assert.equal((await query("SELECT current_database() AS name")).rows[0].name,"mbt_test","Never replay on production");
const dir="test-artifacts/so-delivery-cleanup-apply-20260915";
const retryDriver=process.argv.find(value=>value.startsWith("--driver="))?.slice("--driver=".length);
const reportFile=retryDriver?"pwa-recheck.json":"pwa-replay.json";
const today=JSON.parse(readFileSync(`${dir}/today-after.json`,"utf8"));
const report={date:today.date,mode:"isolated-real-api-online-replay",boundaries:{externalNetSuite:"disabled",samsara:"disabled",photoStorage:"local stub",camera:"synthetic photo references"},dispatch:[],operator:[],drivers:[],browser:[],blockers:[]};
const checkpoint=()=>writeFileSync(`${dir}/${reportFile}`,JSON.stringify(report,null,2)+"\n");
mkdirSync(`${dir}/screenshots`,{recursive:true});
let server,photoServer,browser;
let sequence=0;
async function request(base,token,path,{body,method="GET",deviceId}={}) {
  const started=Date.now();
  if(retryDriver) process.stderr.write(`Request: ${method} ${path}\n`);
  const response=await fetch(`${base}${path}`,{method,signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token}`,
    [DRIVER_PWA_VERSION_HEADER]:DRIVER_PWA_CURRENT_VERSION,...(deviceId?{"x-mbbs-driver-device":deviceId}:{}),
    ...(body===undefined?{}:{"content-type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body)})
    .catch(error=>{throw Object.assign(error,{path,elapsedMs:Date.now()-started});});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok) throw Object.assign(new Error(payload.error||payload.code||`HTTP ${response.status}`),{code:payload.code,status:response.status,path,payload});
  return payload;
}
async function capture(name,base,pathname,storage,ready) {
  const context=await browser.newContext({viewport:{width:name==="dispatch"?1440:430,height:920},serviceWorkers:"block"});
  const page=await context.newPage(),errors=[],apiErrors=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("response",response=>{if(response.url().includes("/api/")&&response.status()>=400) apiErrors.push({path:new URL(response.url()).pathname,status:response.status()});});
  await page.addInitScript(values=>{for(const [key,value] of Object.entries(values)) localStorage.setItem(key,value);},storage);
  try {
    await page.goto(`${base}${pathname}`,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(selector=>document.querySelector(selector)?.innerText.trim().length>40,ready,{timeout:30000});
    if(name==="operator") {
      const module=page.locator('[data-action="open-module"][data-module="delivery"]');
      if(await module.count()) await module.click();
      const type=page.locator('[data-action="select-delivery-type"][data-order-type="sales_order"]');
      if(await type.count()) await type.click();
      await page.waitForFunction(()=>document.querySelector(".order-card"),{timeout:30000});
    }
    await page.screenshot({path:`${dir}/screenshots/${name}.png`,fullPage:true});
    report.browser.push({screen:name,loaded:true,errors,apiErrors,text:(await page.locator(ready).innerText()).slice(0,800)});
  } catch(error) {
    await page.screenshot({path:`${dir}/screenshots/${name}-attention.png`,fullPage:true});
    report.browser.push({screen:name,loaded:false,url:page.url(),error:error.message,errors,apiErrors,text:(await page.locator("body").innerText()).slice(0,1200)});
  }
  finally {checkpoint();await context.close();}
}
async function dispatchReplay(base,token) {
  for(const retained of today.plans) {
    try {
      const plan=await getDispatchPlan(retained.id),sessionId=randomUUID();
      const lease=await request(base,token,"/api/dispatch/plan-edit-lease/acquire",{method:"POST",body:{planDate:today.date,sessionId}});
      const leaseToken=lease.editLeaseToken;
      const response=await fetch(`${base}/api/dispatch/plans/${plan.id}`,{method:"PUT",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","x-dispatch-edit-lease":leaseToken},
        body:JSON.stringify({...plan,baseRevision:plan.revision,sessionId})});
      const result=await response.json();
      report.dispatch.push({planId:plan.id,saveStatus:response.status,code:result.code,error:result.error,applied:result.applied,validationIssues:result.validationIssues});
      if(response.status!==200) report.blockers.push({screen:"dispatch",planId:plan.id,...report.dispatch.at(-1)});
    } catch(error) {report.blockers.push({screen:"dispatch",planId:retained.id,error:error.message,code:error.code});}
    checkpoint();
  }
}
async function operatorReplay(base,token) {
  for(const candidate of today.feeds.loadActive.filter(order=>order.yardStatus!=="Loaded")) {
    const id=candidate.id;
    try {
      const detail=await getDeliveryOrder(id);
      assert(detail,"Operator order detail must exist");
      let packed=0;
      for(const line of detail.lines||[]) {
        if(!line.netsuite_active||!["InvtPart","NonInvtPart"].includes(line.item_type)||line.no_yard_load_required) continue;
        if(/^(DELIVERY CHARGE|SALES CREDIT)/i.test(line.sku||line.item_name||"")) continue;
        const remaining=Math.max(0,Number(line.quantity||0)-Number(line.loaded_qty||0));
        if(!remaining) continue;
        await request(base,token,`/api/delivery/orders/${encodeURIComponent(id)}/lines/${encodeURIComponent(line.id)}/packed-quantity`,{method:"POST",body:{
          pallets:Number(line.pallet_qty||0),layers:Number(line.layer_qty||0),sections:Number(line.section_qty||0),pieces:Number(line.piece_qty||0),
          salesQty:[line.to_plt,line.to_lyr,line.to_sec,line.to_pcs].some(value=>Number(value)>0)?0:remaining}});
        packed++;
      }
      if(packed) {
        await request(base,token,`/api/delivery/orders/${encodeURIComponent(id)}/status`,{method:"POST",body:{status:"packed"}});
        await request(base,token,`/api/delivery/orders/${encodeURIComponent(id)}/load`,{method:"POST",body:{requestId:randomUUID(),orderType:detail.order_type,
          locationId:detail.outbound_location_id,photoDataUrls:[1,2].map(n=>`r2://cleanup-isolated/operator/${id}/photo-${n}.jpg`)}});
      }
      const after=await getDeliveryOrder(id);
      report.operator.push({id,ref:candidate.ref,packedLines:packed,status:after.operator_status,yardStatus:after.local_yard_order_status});
      if(packed&&after.local_yard_order_status!=="Loaded") report.blockers.push({screen:"operator",...report.operator.at(-1)});
    } catch(error) {
      report.blockers.push({screen:"operator",id,ref:candidate.ref,error:error.message,code:error.code,details:error.payload});
      await request(base,token,`/api/delivery/orders/${encodeURIComponent(id)}/release-draft`,{method:"POST",body:{}}).catch(()=>{});
    }
    checkpoint();process.stderr.write(`Operator replay: ${candidate.ref}\n`);
  }
}
async function completeJob(base,token,deviceId,driver,job) {
  const post=(path,body)=>request(base,token,path,{method:"POST",body,deviceId});
  if(job.stopType==="truck_switch") return post(`/api/driver/jobs/${encodeURIComponent(job.jobId)}/skip-samsara`,{});
  await post(`/api/driver/jobs/${encodeURIComponent(job.jobId)}/start`,{deviceOccurredAt:new Date().toISOString()});
  await query("UPDATE driver_job_records SET started_at=now()-interval '11 seconds' WHERE lower(driver_login)=lower($1) AND status='in_progress'",[driver]);
  const photoDataUrls=[];
  for(let i=0;i<(Number(job.requiredPhotos)>0?Math.max(2,Number(job.requiredPhotos)):0);i++) {
    const ticket=await post("/api/driver/photo-upload-token",{recordType:"driver-stop-photo",jobId:job.jobId,planId:job.planId,loadId:job.loadId,stopId:job.stopId,mimeType:"image/jpeg"});
    const form=new FormData();form.append("file",new Blob([new Uint8Array([255,216,1,255,217])],{type:"image/jpeg"}),"photo.jpg");
    const upload=await fetch(ticket.uploadUrl,{method:"POST",headers:{authorization:`Bearer ${ticket.token}`},body:form});
    assert.equal(upload.status,200);photoDataUrls.push(`r2://${(await upload.json()).key}`);
  }
  await post(`/api/driver/jobs/${encodeURIComponent(job.jobId)}/photos`,{photoDataUrls,locationOverride:true,autoStartNext:false});
  return photoDataUrls.length;
}
async function driverReplay(base,driver,index) {
  const deviceId=randomUUID();
  const login=await request(base,"","/api/driver/login",{method:"POST",body:{username:driver,password:"",deviceId},deviceId});
  if(index===0) await capture("driver",base,"/driver",{"mbbs.driver.token":login.token,"mbbs.driver.deviceId":deviceId,"mbbs.ui.language":"en"},"#driverApp");
  const initial=await getDriverDayJobs(driver,{date:today.date});
  const outstanding=initial.jobs.filter(job=>job.status!=="complete");
  const visits=new Set();let actions=0,photos=0;
  for(let i=0;i<initial.jobs.length+5;i++) {
    const next=await request(base,login.token,"/api/driver/next-job",{deviceId});
    if(!next.job) {assert.equal(next.state?.allJobsComplete,true);break;}
    assert(!visits.has(next.job.jobId),"The Driver next job repeated after completion");
    visits.add(next.job.jobId);
    photos+=Number(await completeJob(base,login.token,deviceId,driver,next.job))||0;actions++;
    process.stderr.write(`Driver replay: ${driver} ${next.job.stopType} ${actions}\n`);
  }
  const after=await getDriverDayJobs(driver,{date:today.date});
  const remaining=after.jobs.filter(job=>job.status!=="complete");
  assert.equal(remaining.length,0,JSON.stringify(remaining.map(job=>({jobId:job.jobId,status:job.status}))));
  report.drivers.push({driver,initialJobs:initial.jobs.length,outstanding:outstanding.length,actions,photos,remaining:remaining.length});
  checkpoint();
}
try {
  const retainedFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>{
    const host=new URL(String(url)).hostname;
    if(!["127.0.0.1","localhost"].includes(host)) return Promise.reject(new Error(`External integration disabled in isolated replay: ${host}`));
    return retainedFetch(url,{...options,signal:options?.signal||AbortSignal.timeout(30000)});
  };
  // Only the clone's external-integration boundaries are replaced.
  await query("UPDATE dispatch_drivers SET samsara_enabled=false,password_hash=NULL,password_salt=NULL WHERE active");
  await query("UPDATE mbt_feature_flags SET enabled=false,revision=revision+1 WHERE flag_key='driver_offline_mode' OR flag_key LIKE 'operator_netsuite_delivery_prep_if_%'");
  config.photoUpload={...config.photoUpload,provider:"r2",workerUrl:"http://127.0.0.1:3999",tokenSecret:"isolated-photo-replay-only"};
  photoServer=http.createServer((req,res)=>{req.resume();req.on("end",()=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({key:`cleanup-isolated/driver/photo-${++sequence}.jpg`}));});});
  await new Promise(resolve=>photoServer.listen(3999,"127.0.0.1",resolve));
  const username=`cleanup-replay-${randomUUID().slice(0,8)}`;
  await createOperator({username,displayName:"Isolated cleanup replay",password:"cleanup-replay-test-password",role:"admin"});
  const session=await loginOperator(username,"cleanup-replay-test-password");
  server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
  const staff={"mbbs.staff.token":session.token,"mbbs.operator.token":session.token,"mbbs.dispatch.token":session.token,"mbbs.ui.language":"en","mbbs.operator.locationId":"1",
    "mbbs.staff.role":"admin","mbbs.staff.roles":JSON.stringify(["admin"]),
    "mbbs.operator.state":JSON.stringify({accountId:session.operator.id,sessionKey:createHash("sha256").update(session.token).digest("hex"),locationId:1,currentModule:"menu"})};
  await capture("operator",base,"/operator",staff,"#app");
  await capture("dispatch",base,"/dispatch/planning",staff,"#dispatchApp");
  if(!retryDriver) {
    await dispatchReplay(base,session.token);
    await operatorReplay(base,session.token);
  }
  const routes=today.routes.filter(route=>!retryDriver||route.driver===retryDriver);
  assert(routes.length,"The requested Driver must have a route today");
  for(const [index,route] of routes.entries()) {
    try {await driverReplay(base,route.driver,index);}
    catch(error) {report.blockers.push({screen:"driver",driver:route.driver,error:error.message,code:error.code,path:error.path,elapsedMs:error.elapsedMs,details:error.payload});}
  }
} finally {
  checkpoint();
  console.log(JSON.stringify({operator:report.operator.length,drivers:report.drivers.length,browser:report.browser.map(row=>({screen:row.screen,loaded:row.loaded})),blockers:report.blockers}));
  await browser?.close();
  if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(photoServer) await new Promise(resolve=>photoServer.close(resolve));
  await closeDb();
}
