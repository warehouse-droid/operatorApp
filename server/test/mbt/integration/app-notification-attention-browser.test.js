/* global window,document,localStorage,sessionStorage,navigator,Notification,CustomEvent,Event */
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

let server,browser,base,operator,index=0;
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://test').pathname;
    if(path==='/api/auth/me') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({operator}));return;}
    if(path==='/') {
      res.setHeader('Content-Type','text/html');
      res.end('<title>MBBS Dispatch</title><aside><button data-personal-preferences hidden>Personal preferences</button></aside><header class="topbar"><div class="actions"></div></header><main><button>Work on request</button></main><script src="/app-alert-sound.js"></script><script src="/app-notifications.js"></script>');return;
    }
    try {res.setHeader('Content-Type',path.endsWith('.webmanifest')?'application/manifest+json':'text/javascript');res.end(await fs.readFile(new URL(`../../../public/${path.slice(1)}`,import.meta.url)));}
    catch {res.writeHead(404);res.end();}
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
beforeEach(()=>{operator={id:'dispatch-attention',role:'dispatcher',roles:['dispatcher']};});
after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});

async function open(realAudio=false) {
  const context=await browser.newContext(),page=await context.newPage();
  context.setDefaultTimeout(5000);
  if(process.env.DELIVERY_UI_COVERAGE==='1') {
    await page.coverage.startJSCoverage({resetOnNavigation:false});const close=context.close.bind(context);
    context.close=async()=>{try {await fs.writeFile(`test-artifacts/delivery-requests-ui/attention-coverage-${++index}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));}finally {await close();}};
  }
  await context.addInitScript(({real})=>{
    localStorage.setItem('mbbs.staff.token','attention-token');
    window.notices=[];window.badges=[];window.contexts=[];
    window.hidden=sessionStorage.getItem('test.attention.background')==='true';window.focused=!window.hidden;
    window.permission='granted';window.blockAudio=false;window.delayAudio=false;window.failBadge=false;window.failNotice=false;
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.hidden});document.hasFocus=()=>window.focused;
    Object.defineProperty(Notification,'permission',{configurable:true,get:()=>window.permission});
    Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:async()=>({active:{state:'activated'},showNotification:async(title,options)=>{
      if(window.failNotice) {throw new Error('OS notification unavailable');}window.notices.push({title,options});
    }})}});
    Object.defineProperty(navigator,'setAppBadge',{configurable:true,value:async count=>{if(window.failBadge) {throw new Error('Badge unavailable');}window.badges.push({kind:'set',count});}});
    Object.defineProperty(navigator,'clearAppBadge',{configurable:true,value:async()=>{window.badges.push({kind:'clear'});}});
    if(!real) {
      window.AudioContext=class {
        constructor() {this.state='suspended';this.currentTime=0;this.destination={};this.notes=[];window.contexts.push(this);}
        async resume() {
          if(window.blockAudio) {return new Promise(()=>{});}
          if(window.delayAudio) {return new Promise(resolve=>{window.finishAudio=()=>{this.state='running';resolve();};});}
          this.state='running';
        }
        async close() {this.state='closed';}
        createGain() {return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
        createOscillator() {
          const note={};this.notes.push(note);
          return {set type(value){note.type=value;},frequency:{setValueAtTime(value,time){note.frequency=value;note.start=time;},exponentialRampToValueAtTime(value,time){note.ramp=value;note.rampAt=time;}},connect(){},disconnect(){},start(){},stop(time){note.stop=time;}};
        }
      };
    } else {
      const Native=window.AudioContext;
      window.AudioContext=new Proxy(Native,{construct(Target,args){
        const nativeContext=new Target(...args),record={context:nativeContext,notes:[],ended:0},create=nativeContext.createOscillator.bind(nativeContext);
        nativeContext.createOscillator=()=>{const node=create();record.notes.push(node);node.addEventListener('ended',()=>record.ended++);return node;};
        window.contexts.push(record);return nativeContext;
      }});
    }
  },{real:realAudio});
  await page.goto(base);await openPreferences(page);await expect(page.getByRole('button',{name:'OS notifications on',exact:true})).toBeVisible();
  return {page,context};
}
const alert={id:'delivery:attention:1',title:'Delivery updated',body:'Sales requested a new timeslot.',url:'/dispatch/delivery-requests?request=1'};
const notes=page=>page.evaluate(()=>window.contexts.flatMap(context=>context.notes));
const notify=(page,item=alert)=>page.evaluate(value=>window.MBBSOSNotifications.notify(value),item);
async function background(page) {await page.evaluate(()=>{sessionStorage.setItem('test.attention.background','true');window.hidden=true;window.focused=false;document.dispatchEvent(new Event('visibilitychange'));});}
async function openPreferences(page) {await page.getByRole('button',{name:'Personal preferences',exact:true}).click();}

test('shared alerts use the Operator ding, mute independently, and do not repeat on refresh',async()=>{
  const {page,context}=await open();
  try {
    assert.equal((await notes(page)).length,0);
    await page.getByRole('button',{name:'Enable alert sound',exact:true}).click();
    await expect(page.getByRole('button',{name:'Alert sound on',exact:true})).toBeVisible();
    assert.equal(await notify(page),true);
    const played=await notes(page);assert.equal(played.length,3);
    assert.equal(await page.evaluate(()=>window.notices[0].options.silent),true);
    assert.deepEqual(played.map(note=>[note.frequency,note.start,note.type]),[[1046.5,0,'triangle'],[1568,0.18,'triangle'],[2093,0.28,'triangle']]);
    assert.equal(played[1].ramp,1568*1.18);assert.equal(played[1].stop,0.18+0.52+0.03);
    assert.equal(await notify(page),false);assert.equal((await notes(page)).length,3);
    await page.getByRole('button',{name:'Alert sound on',exact:true}).click();
    await expect(page.getByRole('button',{name:'Alert sound off',exact:true})).toBeVisible();
    assert.equal(await notify(page,{...alert,id:'delivery:attention:2'}),true);
    assert.equal((await notes(page)).length,3);assert.equal(await page.evaluate(()=>window.notices.length),2);
    assert.equal(await page.evaluate(()=>window.notices[1].options.silent),true);
  } finally {await context.close();}
});

test('all four popup types use the shared Operator sound even without OS permission',async()=>{
  const {page,context}=await open();
  try {
    await page.evaluate(()=>{window.permission='denied';});
    await page.getByRole('button',{name:'Enable alert sound',exact:true}).click();
    await page.getByRole('button',{name:'Close personal preferences',exact:true}).click();
    const classes=['delivery-request-dialog','regular-stock-popup','special-delivery-method-dialog','special-po-reference-dialog'];
    for(const [i,name] of classes.entries()) {
      await page.evaluate(value=>{
        const modal=document.createElement('dialog');modal.className=value;modal.dataset.osNotificationId='popup:'+value;
        modal.innerHTML='<h2>MBBS update</h2><p>Your request changed.</p><a href="/dispatch/delivery-requests">Open request</a>';
        document.body.append(modal);modal.showModal();
      },name);
      await expect.poll(async()=>(await notes(page)).length).toBe((i+1)*3);
      await page.evaluate(value=>{const modal=document.querySelector('.'+value);modal.close();modal.remove();},name);
    }
    assert.equal(await page.evaluate(()=>window.notices.length),0);
  } finally {await context.close();}
});

test('sound works when OS permission is denied, and a muted event can sound after unmuting',async()=>{
  const {page,context}=await open();
  try {
    await page.evaluate(()=>{window.permission='denied';});
    await page.getByRole('button',{name:'Enable alert sound',exact:true}).click();
    assert.equal(await notify(page),false);assert.equal((await notes(page)).length,3);
    assert.equal(await page.evaluate(()=>window.notices.length),0);
    await page.getByRole('button',{name:'Alert sound on',exact:true}).click();
    await notify(page,{...alert,id:'delivery:attention:2'});assert.equal((await notes(page)).length,3);
    await page.getByRole('button',{name:'Alert sound off',exact:true}).click();
    await expect(page.getByRole('button',{name:'Alert sound on',exact:true})).toBeVisible();
    await notify(page,{...alert,id:'delivery:attention:2'});assert.equal((await notes(page)).length,6);
  } finally {await context.close();}
});

test('cross-tab notifications play one ding and increment the background badge once per event',async()=>{
  const {page,context}=await open();
  try {
    await page.getByRole('button',{name:'Enable alert sound',exact:true}).click();
    const other=await context.newPage();await other.goto(base);await openPreferences(other);
    await other.getByRole('button',{name:'Enable alert sound',exact:true}).click();
    await background(page);await background(other);
    await Promise.all([notify(page),notify(other),notify(page)]);
    assert.equal((await notes(page)).length+(await notes(other)).length,3);
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.dispatch-attention')),'1');
    assert.equal(await page.evaluate(()=>window.notices.length)+await other.evaluate(()=>window.notices.length),1);
    await page.reload();await background(page);await notify(page);
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.dispatch-attention')),'1');
  } finally {await context.close();}
});

test('unread taskbar badges clear only when returning to visible focused MBBS, without taking focus',async()=>{
  const {page,context}=await open();
  try {
    await page.evaluate(()=>{window.focusRequests=0;window.focus=()=>{window.focusRequests++;};});
    await background(page);await notify(page);await notify(page,{...alert,id:'delivery:attention:2'});
    await expect.poll(()=>page.evaluate(()=>window.badges.filter(item=>item.kind==='set').at(-1)?.count)).toBe(2);
    await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));});
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.dispatch-attention')),'2');
    await page.evaluate(()=>{window.hidden=false;window.focused=false;document.dispatchEvent(new Event('visibilitychange'));});
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.dispatch-attention')),'2');
    await page.evaluate(()=>{window.focused=true;window.dispatchEvent(new Event('focus'));});
    await expect.poll(()=>page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.dispatch-attention'))).toBe('0');
    await notify(page,{...alert,id:'delivery:attention:3'});
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.dispatch-attention')),'0');
    assert.equal(await page.title(),'MBBS Dispatch');assert.equal(await page.evaluate(()=>window.focusRequests),0);
  } finally {await context.close();}
});

test('blocked sound, unavailable badges and OS failure keep other alert channels and retries usable',async()=>{
  const {page,context}=await open();
  try {
    await page.evaluate(()=>{window.blockAudio=true;window.failBadge=true;});
    await page.getByRole('button',{name:'Enable alert sound',exact:true}).click();
    await expect(page.locator('.app-os-notification-status')).toContainText('sound could not');
    await background(page);assert.equal(await notify(page),true);assert.equal((await notes(page)).length,0);
    await page.evaluate(()=>{window.blockAudio=false;window.failBadge=false;window.failNotice=true;});
    await page.getByRole('button',{name:'Enable alert sound',exact:true}).click();
    await expect(page.getByRole('button',{name:'Alert sound on',exact:true})).toBeVisible();
    assert.equal(await notify(page,{...alert,id:'delivery:attention:2'}),false);assert.equal((await notes(page)).length,3);
    await page.evaluate(()=>{window.failNotice=false;});
    assert.equal(await notify(page,{...alert,id:'delivery:attention:2'}),true);assert.equal((await notes(page)).length,3);
  } finally {await context.close();}
});

test('logout clears old badges, closes sound and prevents delayed playback or notification delivery',async()=>{
  const {page,context}=await open();
  try {
    await page.getByRole('button',{name:'Enable alert sound',exact:true}).click();await background(page);await notify(page);
    assert.equal((await notes(page)).length,3);
    await page.evaluate(item=>{window.delayAudio=true;window.pendingNotice=window.MBBSOSNotifications.notify(item);},{...alert,id:'delivery:attention:2'});
    await expect.poll(()=>page.evaluate(()=>typeof window.finishAudio)).toBe('function');
    await page.evaluate(()=>{localStorage.removeItem('mbbs.staff.token');window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed'));window.finishAudio();});
    assert.equal(await page.evaluate(()=>window.pendingNotice),false);assert.equal((await notes(page)).length,3);
    await expect.poll(()=>page.evaluate(()=>window.badges.at(-1)?.kind)).toBe('clear');
    assert.equal(await page.evaluate(()=>window.contexts.every(item=>item.state==='closed')),true);
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.dispatch-attention')),'0');
    await expect(page.getByRole('button',{name:'Alert sound on',exact:true})).toHaveCount(0);
  } finally {await context.close();}
});

test('private authority and local links still gate sound and bounded badge counts',async()=>{
  const {page,context}=await open();
  try {
    await page.getByRole('button',{name:'Enable alert sound',exact:true}).click();await background(page);
    assert.equal(await notify(page,{...alert,url:'https://foreign.invalid/private'}),false);assert.equal((await notes(page)).length,0);
    await page.evaluate(()=>{localStorage.setItem('mbbs.app-badge.unread.dispatch-attention','corrupt');});
    await notify(page);assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.dispatch-attention')),'1');
    await page.evaluate(()=>{localStorage.setItem('mbbs.app-badge.unread.dispatch-attention','500');});
    await notify(page,{...alert,id:'delivery:attention:2'});assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.dispatch-attention')),'500');
    operator={id:'public-sales',publicSales:true,role:'sales'};
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.app-os-notifications')).toHaveCount(0);
    assert.equal(await notify(page,{...alert,id:'delivery:attention:3'}),false);assert.equal((await notes(page)).length,6);
  } finally {await context.close();}
});

test('the real Chromium AudioContext runs the shared ding through oscillator completion',async()=>{
  const {page,context}=await open(true);
  try {
    await page.getByRole('button',{name:'Enable alert sound',exact:true}).click();
    await expect(page.getByRole('button',{name:'Alert sound on',exact:true})).toBeVisible();
    assert.equal(await notify(page),true);
    await expect.poll(()=>page.evaluate(()=>window.contexts.reduce((sum,item)=>sum+item.ended,0))).toBe(3);
    await expect.poll(()=>page.evaluate(()=>window.contexts.every(item=>item.context.state==='closed'))).toBe(true);
  } finally {await context.close();}
});

test('staff pages expose an installable manifest while keeping existing application manifests',async()=>{
  const response=await fetch(base+'/staff-manifest.webmanifest');assert.equal(response.status,200);
  const manifest=await response.json();assert.equal(manifest.id,'/staff');assert.equal(manifest.scope,'/');assert.equal(manifest.display,'standalone');
  assert.equal(manifest.start_url,'/');assert.ok(manifest.icons.some(icon=>icon.sizes==='192x192'));
  const source=await fs.readFile(new URL('../../../public/app-sidebar.js',import.meta.url),'utf8');
  assert.match(source,/staff-manifest\.webmanifest/);assert.match(source,/link\[rel=["']manifest["']\]/);
  const operatorManifest=JSON.parse(await fs.readFile(new URL('../../../public/manifest.webmanifest',import.meta.url),'utf8'));
  const driverManifest=JSON.parse(await fs.readFile(new URL('../../../public/driver-manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(operatorManifest.id,'/operator');assert.equal(driverManifest.id,'/driver');
});
