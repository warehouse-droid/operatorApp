import assert from "node:assert/strict";
// Diagnostic only: exact deployed public assets, native Chromium media API,
// generated browser camera device, fixture API responses, no production writes.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";

const art = path.resolve(process.env.OPERATOR_CAMERA_REPRO_ARTIFACTS || "test-artifacts/operator-group-camera");
const root = process.env.OPERATOR_CAMERA_REPRO_ROOT || path.join(art, "repro-live");
const pwa=true;
let serveBaseline = true;
const server = createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname;
  const file = name === "/operator" ? "operator.html" : name.slice(1);
  if (file.includes("..")) return res.writeHead(404).end();
  try {
    const folder = serveBaseline && ["operator.js","operator-inventory.js","operator.html","service-worker.js"].includes(file) ? "/release/baseline/public" : root;
    const bytes = await readFile(path.join(folder, file));
    res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream" }).end(bytes);
  } catch { res.writeHead(404).end(); }
}).listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let display;
let displayName;
let browserSettings;
if(pwa) {
  display=spawn("Xvfb",["-displayfd","1","-screen","0","1400x1000x24","-nolisten","tcp"],{stdio:["ignore","pipe","pipe"]});
  displayName=await new Promise((resolve,reject)=>{display.stdout.once("data",data=>resolve(":"+data.toString().trim()));display.once("error",reject);display.once("exit",code=>reject(new Error("Xvfb exited: "+code)));});
  browserSettings=await mkdtemp(path.join(tmpdir(),"operator-pwa-config-"));
}
const launch={headless:!pwa,args:["--no-sandbox","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"],...(pwa?{env:{...process.env,DISPLAY:displayName,XDG_CONFIG_HOME:browserSettings,XDG_CACHE_HOME:browserSettings}}:{})};
const browser = pwa ? null : await chromium.launch(launch);
const report = {release:JSON.parse(await readFile(path.join(art,"repro-live-manifest.json"),"utf8")),browser:browser?.version(),hardware:"Chromium generated camera, not an Android tablet",pwa,runs:[]};
let activeContext;


try {
  for (const kind of (process.argv[2] ? [process.argv[2]] : ["delivery","receipt","return"])) {
    const options={viewport:{width:1000,height:800},isMobile:true,hasTouch:true,permissions:["camera"],serviceWorkers:pwa?"allow":"block",
      ...(process.env.OPERATOR_CAMERA_REPRO_UA ? {userAgent:process.env.OPERATOR_CAMERA_REPRO_UA} : {})};
    const context=pwa ? await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),"operator-camera-pwa-")),{...launch,...options}) : await browser.newContext(options);
    activeContext=context;
    context.setDefaultTimeout(15000);
    console.log(JSON.stringify({kind,stage:"browser started",pwa}));
    let page=context.pages()[0] || await context.newPage();
    const run={kind,errors:[],phases:[]};report.runs.push(run);
    page.on("pageerror",err=>run.errors.push(err.message));
    context.on("page",next=>next.on("pageerror",err=>run.errors.push(err.message)));
    await context.addInitScript(allowedOrigin => {
      if(location.origin!==allowedOrigin)return;
      localStorage.setItem("mbbs.staff.token","isolated-camera-reproduction");
      window.EventSource=class {addEventListener(){}close(){}};
      window.cameraEvidence={requests:[],playback:[],events:[]};
      for(const event of ["pagehide","pageshow","visibilitychange","freeze","resume"])
        (event==="pagehide"||event==="pageshow"?window:document).addEventListener(event,e=>window.cameraEvidence.events.push({at:performance.now(),event,visibility:document.visibilityState,persisted:e.persisted}));
      const nativeGet=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async constraints=>{
        const entry={at:performance.now(),constraints};window.cameraEvidence.requests.push(entry);
        try {const stream=await nativeGet(constraints);const track=stream.getVideoTracks()[0];
          const {deviceId,groupId,...settings}=track.getSettings();entry.settings=settings;
          return stream;
        }catch(error){entry.error={name:error.name,message:error.message};throw error;}
      };
      const nativePlay=HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play=function(){
        const entry={at:performance.now(),id:this.id};window.cameraEvidence.playback.push(entry);
        return nativePlay.call(this).then(value=>{entry.result="playing";return value;},error=>{entry.error={name:error.name,message:error.message};throw error;});
      };
      for(const event of ["loadeddata","playing","pause","emptied","error"])
        document.addEventListener(event,e=>{if(e.target instanceof HTMLVideoElement)window.cameraEvidence.events.push({at:performance.now(),event,id:e.target.id,readyState:e.target.readyState});},true);
    },base);
    await context.route("**/*",async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==base)return route.abort();
      if(!url.pathname.startsWith("/api/"))return route.continue();
      let data=[];
      if(url.pathname==="/api/auth/me")data={operator:{id:"camera-reproduction",display_name:"Camera Reproduction",role:"operator",roles:["operator"],operatorYardLocationIds:[1]}};
      else if(url.pathname.endsWith("/notifications"))data={total:0,items:[],salesOrder:{},transferOrder:{}};
      else if(url.pathname.endsWith("/current-draft"))data=null;
      else if(url.pathname.includes("photo-requirement"))data={required:true,requiredPhotoCount:1};
      else if(url.pathname.includes("netsuite-posting-policy"))data={effective:false,transactionType:"IF",revision:1};
      await route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
    });
    await page.goto(base+"/operator");
    await page.locator('[data-action="open-module"][data-module="delivery"]').waitFor();
    console.log(JSON.stringify({kind,stage:"operator ready",pwa}));
    if(pwa) {
      try {await page.waitForFunction(()=>!!navigator.serviceWorker.controller,null,{timeout:10000});}
      catch(error) {
        run.workerDiagnostic=await page.evaluate(async()=>({secure:isSecureContext,registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>({scope:r.scope,active:r.active?.state,installing:r.installing?.state,waiting:r.waiting?.state})),cacheNames:await caches.keys()}));
        console.log(JSON.stringify({kind,workerDiagnostic:run.workerDiagnostic}));throw error;
      }
      console.log(JSON.stringify({kind,stage:"service worker active",pwa}));
      await page.waitForLoadState("networkidle");
      run.oldCaches=await page.evaluate(()=>caches.keys());
      assert(run.oldCaches.includes("mbbs-yard-operator-20260930-android-camera-rollback-v1"));
      serveBaseline=false;
      await page.evaluate(()=>{void navigator.serviceWorker.ready.then(registration=>registration.update());});
      for (let attempt=0;attempt<100;attempt++) {
        const names=await page.evaluate(()=>caches.keys()).catch(()=>[]);
        if(names.join()==="mbbs-yard-operator-20260930-android-native-camera-v2") break;
        await page.waitForTimeout(100);
      }
      await page.waitForLoadState("networkidle");
      await page.locator('[data-action="open-module"][data-module="delivery"]').waitFor();

      const session=await context.newCDPSession(page);
      report.browser=(await session.send("Browser.getVersion")).product;
      const send=async(method,params)=>{
        let timer;
        try{return await Promise.race([session.send(method,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(method+" timed out")),20000);})]);}
        finally{clearTimeout(timer);}
      };
      run.install=await send("PWA.install",{manifestId:base+"/operator",installUrlOrBundleUrl:base+"/operator"});
      await session.send("PWA.changeAppUserSettings",{manifestId:base+"/operator",displayMode:"standalone"});
      run.osAppState=await session.send("PWA.getOsAppState",{manifestId:base+"/operator"});
      const opened=context.waitForEvent("page");
      run.launch=await session.send("PWA.launch",{manifestId:base+"/operator"});
      const installed=await opened;
      await installed.waitForLoadState("domcontentloaded");
      await installed.locator('[data-action="open-module"][data-module="delivery"]').waitFor();
      await page.close();page=installed;
      run.standalone=await page.evaluate(()=>({standalone:matchMedia("(display-mode: standalone)").matches,controlled:!!navigator.serviceWorker.controller,cacheNames:null}));
      if(!run.standalone.standalone)throw new Error("PWA launch did not produce a standalone window");
      run.standalone.cacheNames=await page.evaluate(()=>caches.keys());
      assert.deepEqual(run.standalone.cacheNames,["mbbs-yard-operator-20260930-android-native-camera-v2"]);
      console.log(JSON.stringify({kind,pwa:run.standalone}));
    }
    await page.evaluate(async kind=>{
      const order={netsuite_id:"camera-fixture",tranid:"SOB-CAMERA-FIXTURE",order_type:"sales_order",operator_status:"packed",lines:[]};
      if(kind==="receipt") {receivingSelectedOrder={...order,order_type:"purchase_order"};currentModule="receiving";await startReceipt();}
      else if(kind==="return") {resetReturnWorkflow("pallet");currentModule="pallet-return";returnSelectedCustomer={id:"customer-fixture",name:"Fixture"};returnPalletBalance={available:10};returnVehiclePlate="TEST";returnPalletQuantity=1;returnStage="form";render();}
      else {selectedOrder=order;currentModule="delivery";await startFulfillment();}
    },kind);
    if(kind==="return")await page.locator('[data-action="return-open-review"]').click();

    assert.equal(await page.evaluate(()=>window.cameraEvidence.requests.length),0);
    const buffer=Buffer.from(await page.evaluate(()=>{
      const canvas=document.createElement("canvas");canvas.width=480;canvas.height=360;
      const paint=canvas.getContext("2d");paint.fillStyle="#0ab870";paint.fillRect(0,0,480,360);
      return canvas.toDataURL("image/jpeg").split(",")[1];
    }),"base64");
    for(let index=0;index<2;index++) {
      const chooser=page.waitForEvent("filechooser");
      await page.locator('[data-action="start-receipt-camera"]').click();
      const picker=await chooser;
      assert.equal(await picker.element().getAttribute("capture"),"environment");
      await picker.setFiles({name:"camera.jpg",mimeType:"image/jpeg",buffer});
      await page.waitForFunction(count=>receiptPhotoDataUrls.filter(Boolean).length===count,index+1);
    }
    await page.evaluate(()=>{
      Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"hidden"});
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.visibilityState;document.dispatchEvent(new Event("visibilitychange"));
    });
    run.evidence=await page.evaluate(()=>({requests:window.cameraEvidence.requests,photos:receiptPhotoDataUrls.filter(Boolean).length,
      inputs:document.querySelectorAll('input[type="file"]').length,controlled:!!navigator.serviceWorker.controller}));
    assert.equal(run.evidence.requests.length,0);assert.equal(run.evidence.photos,2);assert.equal(run.evidence.inputs,0);
    assert.deepEqual(run.errors,[]);
    await page.screenshot({path:path.join(art,"installed-native-camera.png"),fullPage:true});
    console.log(JSON.stringify({kind,standalone:run.standalone,evidence:run.evidence,errors:run.errors}));
    await context.close();activeContext=null;
  }
} catch(error) {report.harnessError={name:error.name,message:error.message};process.exitCode=1;console.error(error.message);}
finally {
  const reportName=process.argv.includes("--insets-only")?"repro-installed-pwa-insets.json":pwa?`repro-installed-pwa-${process.argv[2] || "all"}.json`:"repro-native.json";
  await writeFile(path.join(art,reportName),JSON.stringify(report,null,2));
  await activeContext?.close();await browser?.close();await new Promise(resolve=>server.close(resolve));display?.kill();
}
