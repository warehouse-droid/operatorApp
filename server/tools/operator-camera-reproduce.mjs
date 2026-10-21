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
const pwa=process.argv.includes("--pwa");
const server = createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname;
  const file = name === "/operator" ? "operator.html" : name.slice(1);
  if (file.includes("..")) return res.writeHead(404).end();
  try {
    const bytes = await readFile(path.join(root, file));
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

async function sample(page, phase, duration=1800) {
  return page.evaluate(async ({phase,duration}) => {
      const rows=[];
    const start=performance.now();
    while(performance.now()-start < duration) {
      const video=document.querySelector("video.camera-preview");
      const track=video?.srcObject?.getVideoTracks()[0];
      let pixelMax=null;
      if(video?.readyState>=2) {
        const canvas=document.createElement("canvas");canvas.width=32;canvas.height=24;
        const ctx=canvas.getContext("2d");ctx.drawImage(video,0,0,32,24);
        const pixels=ctx.getImageData(0,0,32,24).data;pixelMax=0;
        for(let i=0;i<pixels.length;i+=4)pixelMax=Math.max(pixelMax,pixels[i],pixels[i+1],pixels[i+2]);
      }
      rows.push({at:Math.round(performance.now()-start),exists:!!video,readyState:video?.readyState,paused:video?.paused,width:video?.videoWidth,height:video?.videoHeight,time:video?.currentTime,trackState:track?.readyState,muted:track?.muted,pixelMax});
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return {phase,rows};
  },{phase,duration});
}

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
      console.log(JSON.stringify({kind,pwa:run.standalone}));
    }
    await page.evaluate(async kind=>{
      const order={netsuite_id:"camera-fixture",tranid:"SOB-CAMERA-FIXTURE",order_type:"sales_order",operator_status:"packed",lines:[]};
      if(kind==="receipt") {receivingSelectedOrder={...order,order_type:"purchase_order"};currentModule="receiving";await startReceipt();}
      else if(kind==="return") {resetReturnWorkflow("pallet");currentModule="pallet-return";returnSelectedCustomer={id:"customer-fixture",name:"Fixture"};returnPalletBalance={available:10};returnVehiclePlate="TEST";returnPalletQuantity=1;returnStage="form";render();}
      else {selectedOrder=order;currentModule="delivery";await startFulfillment();}
    },kind);
    if(kind==="return")await page.locator('[data-action="return-open-review"]').click();
    run.phases.push(await sample(page,"initial open",2500));
    if(process.argv.includes("--insets-only")) {
      const session=await context.newCDPSession(page);run.insets=[];
      for(const height of [800,560]) {
        await page.setViewportSize({width:1000,height});
        for(const bottom of [0,24,48,0]) {
          await session.send("Emulation.setSafeAreaInsetsOverride",{insets:{bottom}});
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          const geometry=await page.evaluate(()=>{
            const app=document.getElementById("app");
            const action=document.querySelector('[data-action="confirm-receive"]');
            const video=document.querySelector("video.camera-preview");
            return {height:innerHeight,visibleHeight:visualViewport.height,paddingBottom:parseFloat(getComputedStyle(app).paddingBottom),shellBottom:app.getBoundingClientRect().bottom,actionBottom:action?.getBoundingClientRect().bottom,videoWidth:video?.videoWidth,videoReady:video?.readyState};
          });
          run.insets.push({emulatedBottom:bottom,...geometry,clearance:geometry.height-bottom-geometry.actionBottom});
        }
      }
      run.evidence=await page.evaluate(()=>window.cameraEvidence);
      console.log(JSON.stringify({kind,pwa,insets:run.insets,errors:run.errors}));
      await page.screenshot({path:path.join(art,"repro-pwa-insets.png"),fullPage:true});
      await context.close();activeContext=null;continue;
    }
    const slot=kind==="receipt"?"select-receipt-photo-slot":kind==="return"?"return-select-photo-slot":"select-fulfillment-photo-slot";
    for(let i=0;i<(process.argv.includes("--resume-only")?0:5);i++) {
      await page.locator(`[data-action="${slot}"]`).first().click();
      const phase=await sample(page,`photo slot click ${i+1}`,1200);
      run.phases.push(phase);
      if(!phase.rows.some(row=>row.pixelMax>10)) {
        const waiting=await sample(page,`wait after blank slot click ${i+1}`,8000);
        run.phases.push(waiting);
        await page.screenshot({path:path.join(art,`repro-blank-${kind}-${i+1}.png`),fullPage:true});
        console.log(JSON.stringify({kind,phase:waiting.phase,frames:waiting.rows.filter(row=>row.pixelMax>10).length,last:waiting.rows.at(-1)}));
      }
    }
    const stop=kind==="receipt"?"stop-receipt-camera":kind==="return"?"return-close-camera":"stop-camera";
    const start=kind==="receipt"?"start-receipt-camera":kind==="return"?"return-start-camera":"start-camera";
    for(let i=0;i<3;i++) {
      await page.locator(`[data-action="${stop}"]`).click();
      await page.locator(`[data-action="${start}"]`).click();
      run.phases.push(await sample(page,`close and reopen ${i+1}`,1800));
    }
    await page.setViewportSize({width:800,height:1000});
    run.phases.push(await sample(page,"rotate portrait"));
    await page.setViewportSize({width:1000,height:800});
    run.phases.push(await sample(page,"rotate landscape"));
    await page.evaluate(()=>window.dispatchEvent(new Event("pageshow")));
    run.phases.push(await sample(page,"page restore event"));
    if(pwa) {
      const session=await context.newCDPSession(page);
      for(let i=0;i<3;i++) {
        await session.send("Page.setWebLifecycleState",{state:"frozen"});
        await new Promise(resolve=>setTimeout(resolve,1500));
        await session.send("Page.setWebLifecycleState",{state:"active"});
        await page.bringToFront();
        run.phases.push(await sample(page,`PWA frozen/resumed ${i+1}`,2500));
      }
      run.evidence=await page.evaluate(()=>window.cameraEvidence);
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      run.reload=await page.evaluate(()=>({standalone:matchMedia("(display-mode: standalone)").matches,controlled:!!navigator.serviceWorker.controller,module:document.getElementById("app")?.dataset.module}));
      const keeper=await context.newPage();
      const launcher=await context.newCDPSession(keeper);
      await page.close();
      const reopened=context.waitForEvent("page");
      await launcher.send("PWA.launch",{manifestId:base+"/operator"});
      page=await reopened;
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(()=>typeof operator!=="undefined" && !!operator && !!locationId);
      if(kind==="receipt") {
        await page.evaluate(async()=>{
          receivingSelectedOrder={netsuite_id:"camera-fixture",tranid:"SOB-CAMERA-FIXTURE",order_type:"purchase_order",operator_status:"packed",lines:[]};
          currentModule="receiving";await startReceipt();
        });
        run.phases.push(await sample(page,"PWA closed/relaunched then open camera",3000));
      } else if(kind==="delivery") {
        await page.evaluate(async()=>{
          selectedOrder={netsuite_id:"camera-fixture",tranid:"SOB-CAMERA-FIXTURE",order_type:"sales_order",operator_status:"packed",lines:[]};
          currentModule="delivery";await startFulfillment();
        });
        run.phases.push(await sample(page,"PWA closed/relaunched then open camera",3000));
      }
      run.relaunch=await page.evaluate(()=>({standalone:matchMedia("(display-mode: standalone)").matches,controlled:!!navigator.serviceWorker.controller,evidence:window.cameraEvidence}));
      await keeper.close();
    }
    run.evidence ||= await page.evaluate(()=>window.cameraEvidence);
    await mkdir(art,{recursive:true});
    await page.screenshot({path:path.join(art,`repro-${pwa?"pwa":"native"}-${kind}.png`),fullPage:true});
    console.log(JSON.stringify({kind,errors:run.errors,phases:run.phases.map(({phase,rows})=>({phase,frames:rows.filter(r=>r.pixelMax>10).length,samples:rows.length,firstFrame:rows.find(r=>r.pixelMax>10)?.at,last:rows.at(-1)})),playbackErrors:run.evidence.playback.filter(x=>x.error)}));
    await context.close();activeContext=null;
  }
} catch(error) {report.harnessError={name:error.name,message:error.message};process.exitCode=1;console.error(error.message);}
finally {
  const reportName=process.argv.includes("--insets-only")?"repro-installed-pwa-insets.json":pwa?`repro-installed-pwa-${process.argv[2] || "all"}.json`:"repro-native.json";
  await writeFile(path.join(art,reportName),JSON.stringify(report,null,2));
  await activeContext?.close();await browser?.close();await new Promise(resolve=>server.close(resolve));display?.kill();
}
