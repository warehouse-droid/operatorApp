/* global window, document, localStorage, navigator, Notification, Event, Storage */
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

let server,browser,base,operator,responses;
const posted=[];
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://test').pathname;
    if(path.startsWith('/api/')) {
      if(req.method==='POST') {posted.push(path);}
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(path==='/api/auth/me'?{operator}:responses[path] || {count:0,total:0,requests:[],alerts:[]}));return;
    }
    if(path==='/dispatch/preferences-test') {
      res.setHeader('Content-Type','text/html');
      res.end('<title>MBBS Dispatch</title><header class="topbar"><div class="actions"></div></header><main>Work lists</main><script src="/app-sidebar.js"></script>');return;
    }
    if(!/^\/[a-z0-9-]+\.js$/.test(path)) {res.end('');return;}
    try {res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(new URL(`../../../public${path}`,import.meta.url)));}
    catch {res.writeHead(404);res.end();}
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}/dispatch/preferences-test`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
beforeEach(()=>{operator={id:'testAdmin',role:'admin',roles:['admin','sales','dispatcher','scm']};responses={};posted.length=0;});
after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});

async function open(existing) {
  const context=existing || await browser.newContext();context.setDefaultTimeout(5000);
  if(!existing) {
    await context.addInitScript(()=>{
      if(!localStorage.getItem('test.initialized')) {localStorage.setItem('test.initialized','true');localStorage.setItem('mbbs.staff.token','shared-token');}
      window.notices=[];window.sounds=[];window.badges=[];window.background=false;
      window.EventSource=class {addEventListener(){} close(){}};
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.background});document.hasFocus=()=>!window.background;
      Object.defineProperty(Notification,'permission',{configurable:true,get:()=> 'granted'});
      Object.defineProperty(navigator,'setAppBadge',{configurable:true,value:async count=>window.badges.push(count)});
      Object.defineProperty(navigator,'clearAppBadge',{configurable:true,value:async()=>window.badges.push(0)});
      Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:async()=>({
        active:{state:'activated'},getNotifications:async()=>window.notices.map(notice=>({data:notice.options.data,close:()=>{notice.closed=true;}})),
        showNotification:async(title,options)=>{window.notices.push({title,options});}
      })}});
      const Native=window.AudioContext;
      window.AudioContext=new Proxy(Native,{construct(Target,args){
        const audioContext=new Target(...args),create=audioContext.createBufferSource.bind(audioContext),oscillator=audioContext.createOscillator.bind(audioContext),decode=audioContext.decodeAudioData.bind(audioContext);
        audioContext.createBufferSource=()=>{
          const node=create(),start=node.start.bind(node);
          node.start=(...parameters)=>{
            const samples=node.buffer.getChannelData(0);let peak=0,energy=0,signature=0;
            for(const sample of samples) {peak=Math.max(peak,Math.abs(sample));energy+=sample*sample;signature=(Math.imul(signature,31)+Math.round(sample*65535))|0;}
            window.sounds.push({kind:'custom',duration:node.buffer.duration,peak,rms:Math.sqrt(energy/samples.length),signature,first:samples[0],last:samples.at(-1)});start(...parameters);
          };return node;
        };
        audioContext.createOscillator=()=>{window.sounds.push({kind:'default'});return oscillator();};
        audioContext.decodeAudioData=bytes=>window.holdDecode?new Promise((resolve,reject)=>{window.finishDecode=()=>decode(bytes).then(resolve,reject);}):decode(bytes);
        return audioContext;
      }});
    });
  }
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.getByRole('button',{name:'Personal preferences',exact:true}).click();
  return {page,context,errors};
}
const panel=page=>page.getByRole('dialog',{name:'Personal preferences',exact:true});
const mute=(page,role)=>panel(page).getByRole('checkbox',{name:`Mute ${role} alerts`,exact:true});
const status=page=>panel(page).locator('.app-os-notification-status');
const soundName=page=>panel(page).locator('.app-custom-sound-name');
const soundChoice=page=>panel(page).getByRole('combobox',{name:'Choose a sound',exact:true});
const notify=(page,id,role='sales')=>page.evaluate(item=>window.MBBSOSNotifications.notify(item),{id,role,title:'Request changed',body:'An update is available.',url:`/${role}/stock-requests`});
const counts=async pages=>{
  const results=await Promise.all(pages.map(page=>page.evaluate(()=>({os:window.notices.length,custom:window.sounds.filter(sound=>sound.kind==='custom').length,notes:window.sounds.filter(sound=>sound.kind==='default').length}))));
  return results.reduce((total,value)=>({os:total.os+value.os,custom:total.custom+value.custom,notes:total.notes+value.notes}),{os:0,custom:0,notes:0});
};
function wav(seconds=.1) {
  const samples=Math.round(8000*seconds),data=Buffer.alloc(44+samples*2);
  data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);
  data.writeUInt16LE(1,22);data.writeUInt32LE(8000,24);data.writeUInt32LE(16000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);
  data.write('data',36);data.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++) {data.writeInt16LE(Math.round(4000*Math.sin(i*Math.PI/9)),44+i*2);}
  return data;
}
async function upload(page,name='my-chime.wav',buffer=wav(),mimeType='audio/wav') {
  await panel(page).getByLabel('Upload your sound',{exact:true}).setInputFiles({name,mimeType,buffer});
  await expect(panel(page).getByLabel('Upload your sound',{exact:true})).toBeEnabled();
}

test('the gear popup offers the account’s roles, persists independent mutes and leaves work-list counts intact',async()=>{
  const {page,context,errors}=await open();
  try {
    await expect(panel(page).getByRole('checkbox')).toHaveCount(3);
    await mute(page,'Sales').check();await mute(page,'SCM').check();
    assert.equal(await notify(page,'muted-sales'),false);assert.equal(await notify(page,'muted-scm','scm'),false);
    assert.equal(await notify(page,'active-dispatch','dispatch'),true);
    await page.reload();await page.getByRole('button',{name:'Personal preferences',exact:true}).click();
    await expect(mute(page,'Sales')).toBeChecked();await expect(mute(page,'SCM')).toBeChecked();await expect(mute(page,'Dispatch')).not.toBeChecked();
    responses['/api/sales/stock-requests/alerts']={total:1,requests:[{id:11,eventId:22,action:'reply',requestRef:'SR-11',message:'Still in the list'}]};
    await page.evaluate(()=>window.MBBSRegularStockAlert.refresh());
    await page.getByRole('button',{name:'Close personal preferences'}).click();
    await expect(page.locator('.regular-stock-alert[href^="/sales/"]')).toBeVisible();
    await expect(page.locator('.regular-stock-popup')).toHaveCount(0);
    assert.deepEqual(posted,[]);assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('single-role staff and SCM aliases get matching mute options; every staff role can upload sound',async()=>{
  for(const [role,label] of [['sales','Sales'],['dispatcher','Dispatch'],['scm_staff','SCM'],['yard_manager','SCM'],['operator',null]]) {
    operator={id:role,role,roles:[role]};const {page,context}=await open();
    try {
      await expect(panel(page).getByLabel('Upload your sound',{exact:true})).toBeVisible();
      await expect(panel(page).getByRole('checkbox')).toHaveCount(label?1:0);
      if(label) {await expect(mute(page,label)).toBeVisible();}
    } finally {await context.close();}
  }
});

test('muting a role closes its existing popup in other tabs and unmuting restores unacknowledged updates',async()=>{
  const {page,context,errors}=await open(),other=(await open(context)).page;
  try {
    responses['/api/dispatch/delivery-requests/alerts']={count:1,requests:[{id:41,revision:2,requestRef:'DR-41',action:'submit'}]};
    await other.getByRole('button',{name:'Close personal preferences'}).click();
    await other.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(other.locator('.delivery-request-dialog')).toBeVisible();
    await mute(page,'Dispatch').check();
    await expect(other.locator('.delivery-request-dialog')).toHaveCount(0);
    await expect(other.locator('.delivery-request-alert')).toContainText('1');
    await mute(page,'Dispatch').uncheck();
    await expect(other.locator('.delivery-request-dialog')).toBeVisible();
    await page.getByRole('button',{name:'Close personal preferences'}).click();
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    assert.deepEqual(posted,[]);assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('SCM and Dispatch delivery-method popups respect their own role without consuming the muted role',async()=>{
  const {page,context}=await open();
  const notice={id:51,requestId:11,requestRef:'SP-11',beforeMethod:'vendor_pickup',fulfillmentMethod:'mbt_delivery',yardName:'3445',salesOrderRef:'SO-11',purchaseOrderRef:'PO-11',purchaseOrderReference:'Vendor-11'};
  try {
    await mute(page,'SCM').check();
    for(const audience of ['scm','dispatch']) {responses[`/api/${audience}/special-stock-requests/delivery-method-alerts`]={alerts:[{...notice,audience}]};}
    await page.evaluate(()=>window.MBBSSpecialDeliveryMethodAlerts.refresh());
    await page.getByRole('button',{name:'Close personal preferences'}).click();
    await expect(page.locator('.special-delivery-method-dialog')).toHaveAttribute('data-notification-role','dispatch');
    assert.deepEqual(await page.evaluate(()=>window.notices.map(item=>item.options.data.role)),['dispatch']);
    assert.deepEqual(posted,[]);
  } finally {await context.close();}
});

test('PO references and conversation popups are suppressed only for their muted audience',async()=>{
  const {page,context}=await open();
  try {
    await mute(page,'Sales').check();await mute(page,'Dispatch').check();
    const reference={requestId:61,requestRef:'SP-61',displayRef:'Vendor-61',noticeKey:'a'.repeat(64),fulfillmentMethod:'mbt_delivery'};
    responses['/api/sales/special-stock-requests/po-reference-alerts']={alerts:[{...reference,audience:'sales'}]};
    responses['/api/sales/stock-request-conversation-alerts']={count:1,requests:[{id:61,tab:'special',requestRef:'SP-61',latestEventId:61,actorName:'SCM',message:'Sales update'}]};
    responses['/api/scm/stock-request-conversation-alerts']={count:1,requests:[{id:62,tab:'regular',requestRef:'SR-62',latestEventId:62,actorName:'Sales',message:'SCM update'}]};
    await page.evaluate(async()=>{await window.MBBSPoReferenceAlert.refresh();await window.StockRequestConversationAlerts.refresh();});
    await page.getByRole('button',{name:'Close personal preferences'}).click();
    await expect(page.locator('.special-po-reference-dialog')).toHaveCount(0);
    await expect(page.locator('.stock-conversation-notice')).toContainText('SCM update');
    await expect(page.locator('.stock-conversation-alert')).toContainText('2');
    assert.ok((await page.evaluate(()=>window.notices)).every(item=>item.options.data.role==='scm'));assert.deepEqual(posted,[]);
  } finally {await context.close();}
});

test('custom sounds preview, play on alerts, persist across reload and tabs, and reset to the default ding',async()=>{
  const {page,context,errors}=await open();
  try {
    await upload(page,'personal-chime.wav');await expect(soundName(page)).toHaveText('personal-chime.wav');
    await panel(page).getByRole('button',{name:'Preview sound',exact:true}).click();
    await expect.poll(()=>counts([page])).toEqual({os:0,custom:1,notes:0});
    assert.equal(await notify(page,'custom-notice'),true);
    assert.deepEqual(await counts([page]),{os:1,custom:2,notes:0});
    await page.reload();await page.getByRole('button',{name:'Personal preferences',exact:true}).click();
    await expect(soundName(page)).toHaveText('personal-chime.wav');
    const other=(await open(context)).page;await expect(soundName(other)).toHaveText('personal-chime.wav');
    await upload(page,'replacement.wav');await expect(soundName(other)).toHaveText('replacement.wav');
    await panel(page).getByRole('button',{name:'Use default sound',exact:true}).click();
    await expect(soundName(page)).toHaveText('Default ding');await expect(soundName(other)).toHaveText('Default ding');
    await panel(page).getByRole('button',{name:'Preview sound',exact:true}).click();
    await expect.poll(()=>counts([page])).toEqual({os:0,custom:0,notes:3});assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('invalid, empty, oversized and long audio or storage failure preserve the previously saved sound',async()=>{
  const {page,context}=await open();
  try {
    await upload(page,'good.wav');
    for(const [name,buffer,type,message] of [
      ['empty.wav',Buffer.alloc(0),'audio/wav','non-empty'],
      ['oversize.wav',Buffer.alloc(1024*1024+1),'audio/wav','1 MB'],
      ['notes.txt',Buffer.from('text'),'text/plain','audio file'],
      ['fake.wav',Buffer.from('not audio'),'audio/wav','could not be played'],
      ['long.wav',wav(11),'audio/wav','10 seconds']
    ]) {
      await upload(page,name,buffer,type);await expect(status(page)).toContainText(message);await expect(soundName(page)).toHaveText('good.wav');
    }
    await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('mbbs.alert-sound.custom.')) {throw new Error('quota');}return original.call(this,key,value);};});
    await upload(page,'quota.wav');await expect(status(page)).toContainText('Could not save');await expect(soundName(page)).toHaveText('good.wav');
  } finally {await context.close();}
});

test('sound uploads and mute preferences stay with their account, including an upload finishing after logout',async()=>{
  const {page,context}=await open();
  try {
    await upload(page,'admin.wav');await mute(page,'Sales').check();
    await page.evaluate(()=>{window.holdDecode=true;});
    await panel(page).getByLabel('Upload your sound',{exact:true}).setInputFiles({name:'late.wav',mimeType:'audio/wav',buffer:wav()});
    await expect.poll(()=>page.evaluate(()=>typeof window.finishDecode)).toBe('function');
    operator={id:'3445Sales',role:'sales',roles:['sales']};
    await page.evaluate(()=>{localStorage.setItem('mbbs.staff.token','sales-token');window.dispatchEvent(new Event('mbbs-auth-operator-changed'));});
    await page.getByRole('button',{name:'Personal preferences',exact:true}).click();
    await page.evaluate(()=>window.finishDecode());
    await expect(soundName(page)).toHaveText('Default ding');await expect(mute(page,'Sales')).not.toBeChecked();
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.alert-sound.custom.3445Sales')),null);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('mbbs.alert-sound.custom.testAdmin')).name),'admin.wav');
  } finally {await context.close();}
});

test('each browser receives one OS alert and one custom sound across three tabs, while a shared account on another computer also receives it',async()=>{
  operator={id:'3445Sales',role:'sales',roles:['sales']};
  const first=await open(),second=await open();
  try {
    await upload(first.page);await upload(second.page);
    assert.equal(await notify(first.page,'shared-account-event'),true);
    assert.equal(await first.page.evaluate(()=>window.notices[0].options.silent),true);
    assert.deepEqual(await counts([first.page]),{os:1,custom:0,notes:0});
    const tabs=[first.page,(await open(first.context)).page,(await open(first.context)).page];
    for(const page of [...tabs,second.page]) {
      await panel(page).getByRole('button',{name:'Enable alert sound',exact:true}).click();
      await page.evaluate(()=>{window.background=true;});
    }
    await Promise.all([...tabs,second.page].flatMap(page=>[notify(page,'shared-account-event'),notify(page,'shared-account-event')]));
    assert.deepEqual(await counts(tabs),{os:1,custom:1,notes:0});
    assert.deepEqual(await counts([second.page]),{os:1,custom:1,notes:0});
    assert.equal(await second.page.evaluate(()=>localStorage.getItem('mbbs.app-badge.unread.3445Sales')),'1');
    await tabs[1].reload();await tabs[1].getByRole('button',{name:'Personal preferences',exact:true}).click();
    assert.equal(await notify(tabs[1],'shared-account-event'),false);
    assert.deepEqual(await counts([tabs[1]]),{os:0,custom:0,notes:0});
    await mute(first.page,'Sales').check();await expect(mute(tabs[2],'Sales')).toBeChecked();
    await expect(mute(second.page,'Sales')).not.toBeChecked();
    assert.equal(await notify(tabs[2],'local-mute'),false);assert.equal(await notify(second.page,'local-mute'),true);
  } finally {await first.context.close();await second.context.close();}
});

test('an OS-supplied sound is counted so a later unlocked tab cannot sound the same alert again',async()=>{
  const {page,context}=await open();
  try {
    assert.equal(await notify(page,'native-sound'),true);
    assert.equal(await page.evaluate(()=>window.notices[0].options.silent),false);
    const other=(await open(context)).page;
    await panel(other).getByRole('button',{name:'Enable alert sound',exact:true}).click();
    assert.equal(await notify(other,'native-sound'),false);
    assert.deepEqual(await counts([page,other]),{os:1,custom:0,notes:0});
  } finally {await context.close();}
});

test('six free built-in choices preview distinct, audible, short sounds with unclipped samples',async()=>{
  const {page,context,errors}=await open();
  const presets={'bottle-open':'Bottle open','classic-ding':'Classic ding','soft-chime':'Soft chime',bell:'Bell','digital-beep':'Digital beep','bubble-pop':'Bubble pop'};
  try {
    await expect(soundChoice(page)).toHaveValue('default');
    for(const [id,label] of Object.entries(presets)) {
      await expect(soundChoice(page).locator(`option[value="${id}"]`)).toHaveText(label);
      await soundChoice(page).selectOption(id);await expect(soundName(page)).toHaveText(label);
      await panel(page).getByRole('button',{name:'Preview sound',exact:true}).click();
      await expect(status(page)).toHaveText('Playing your notification sound.');
    }
    const sounds=await page.evaluate(()=>window.sounds);
    assert.equal(sounds.length,6);assert.equal(new Set(sounds.map(sound=>sound.signature)).size,6);
    for(const sound of sounds) {
      assert.equal(sound.kind,'custom');assert.ok(sound.duration>=0.2 && sound.duration<=1.5);
      assert.ok(sound.peak>0.1 && sound.peak<=0.51);assert.ok(sound.rms>0.025 && sound.rms<0.3);
      assert.equal(Math.abs(sound.first),0);assert.ok(Math.abs(sound.last)<0.01);
    }
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('built-in choices persist and sync across tabs while keeping an uploaded sound available',async()=>{
  const {page,context}=await open();
  try {
    await upload(page,'keep-my-sound.wav');
    await soundChoice(page).selectOption('bottle-open');
    await page.reload();await page.getByRole('button',{name:'Personal preferences',exact:true}).click();
    await expect(soundChoice(page)).toHaveValue('bottle-open');await expect(soundName(page)).toHaveText('Bottle open');
    const other=(await open(context)).page;
    await expect(soundChoice(other)).toHaveValue('bottle-open');
    await soundChoice(other).selectOption('classic-ding');await expect(soundChoice(page)).toHaveValue('classic-ding');
    await soundChoice(page).selectOption('custom');await expect(soundName(other)).toHaveText('keep-my-sound.wav');
    await panel(other).getByRole('button',{name:'Preview sound',exact:true}).click();
    await expect.poll(()=>other.evaluate(()=>window.sounds.at(-1)?.duration)).toBeCloseTo(0.1,2);
    await soundChoice(page).selectOption('default');await expect(soundChoice(other)).toHaveValue('default');
    await expect(soundChoice(other).locator('[value="custom"]')).toBeEnabled();
    await panel(page).getByRole('button',{name:'Use default sound',exact:true}).click();
    await expect(soundChoice(other).locator('[value="custom"]')).toBeDisabled();
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.alert-sound.custom.testAdmin')),null);
  } finally {await context.close();}
});

test('a failed preset save or invalid upload preserves the prior selection, and unknown saved presets fall back safely',async()=>{
  const {page,context,errors}=await open();
  try {
    await soundChoice(page).selectOption('soft-chime');
    await upload(page,'bad.wav',Buffer.from('not audio'));
    await expect(status(page)).toContainText('could not be played');await expect(soundChoice(page)).toHaveValue('soft-chime');
    await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('mbbs.alert-sound.custom.')) {throw new Error('quota');}return window.originalSetItem.call(this,key,value);};});
    await soundChoice(page).selectOption('bell');await expect(status(page)).toContainText('Could not save');
    await expect(soundChoice(page)).toHaveValue('soft-chime');await expect(soundName(page)).toHaveText('Soft chime');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('mbbs.alert-sound.custom.testAdmin')).preset),'soft-chime');
    await page.evaluate(()=>{Storage.prototype.setItem=window.originalSetItem;localStorage.setItem('mbbs.alert-sound.custom.testAdmin',JSON.stringify({preset:'unavailable-preset'}));});
    await page.reload();await page.getByRole('button',{name:'Personal preferences',exact:true}).click();
    await expect(soundChoice(page)).toHaveValue('default');await expect(status(page)).toContainText('could not be loaded');
    await panel(page).getByRole('button',{name:'Preview sound',exact:true}).click();
    await expect.poll(()=>counts([page])).toEqual({os:0,custom:0,notes:3});assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('built-in selections belong to the signed-in account and survive switching back',async()=>{
  const {page,context}=await open();
  try {
    await soundChoice(page).selectOption('bell');
    operator={id:'3445Sales',role:'sales',roles:['sales']};
    await page.evaluate(()=>{localStorage.setItem('mbbs.staff.token','sales-token');window.dispatchEvent(new Event('mbbs-auth-operator-changed'));});
    await page.getByRole('button',{name:'Personal preferences',exact:true}).click();
    await expect(soundChoice(page)).toHaveValue('default');await soundChoice(page).selectOption('digital-beep');
    operator={id:'testAdmin',role:'admin',roles:['admin','sales','dispatcher','scm']};
    await page.evaluate(()=>{localStorage.setItem('mbbs.staff.token','shared-token');window.dispatchEvent(new Event('mbbs-auth-operator-changed'));});
    await page.getByRole('button',{name:'Personal preferences',exact:true}).click();
    await expect(soundChoice(page)).toHaveValue('bell');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('mbbs.alert-sound.custom.3445Sales')).preset),'digital-beep');
  } finally {await context.close();}
});

test('a chosen preset plays once across three tabs on each computer without an extra system ding',async()=>{
  operator={id:'3445Sales',role:'sales',roles:['sales']};
  const first=await open(),second=await open();
  try {
    await soundChoice(first.page).selectOption('bottle-open');await soundChoice(second.page).selectOption('bubble-pop');
    assert.equal(await notify(first.page,'preset-shared-event'),true);
    assert.equal(await first.page.evaluate(()=>window.notices[0].options.silent),true);
    assert.deepEqual(await counts([first.page]),{os:1,custom:0,notes:0});
    const tabs=[first.page,(await open(first.context)).page,(await open(first.context)).page];
    for(const page of [...tabs,second.page]) {await panel(page).getByRole('button',{name:'Enable alert sound',exact:true}).click();}
    await Promise.all([...tabs,second.page].flatMap(page=>[notify(page,'preset-shared-event'),notify(page,'preset-shared-event')]));
    assert.deepEqual(await counts(tabs),{os:1,custom:1,notes:0});assert.deepEqual(await counts([second.page]),{os:1,custom:1,notes:0});
    await expect(soundChoice(tabs[2])).toHaveValue('bottle-open');await expect(soundChoice(second.page)).toHaveValue('bubble-pop');
    await mute(first.page,'Sales').check();await expect(mute(tabs[2],'Sales')).toBeChecked();
    await Promise.all(tabs.map(page=>notify(page,'muted-preset-event')));
    assert.deepEqual(await counts(tabs),{os:1,custom:1,notes:0});
  } finally {await first.context.close();await second.context.close();}
});

test('a preset selected in another tab wins over an older upload still decoding',async()=>{
  const {page,context}=await open(),other=(await open(context)).page;
  try {
    await page.evaluate(()=>{window.holdDecode=true;});
    await panel(page).getByLabel('Upload your sound',{exact:true}).setInputFiles({name:'late.wav',mimeType:'audio/wav',buffer:wav()});
    await expect.poll(()=>page.evaluate(()=>typeof window.finishDecode)).toBe('function');
    await soundChoice(other).selectOption('digital-beep');await expect(soundChoice(page)).toHaveValue('digital-beep');
    await page.evaluate(()=>window.finishDecode());
    await expect(soundChoice(page)).toHaveValue('digital-beep');await expect(soundChoice(page)).toBeEnabled();
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('mbbs.alert-sound.custom.testAdmin'))),{preset:'digital-beep'});
  } finally {await context.close();}
});

test('the expanded gear popup remains usable on a phone',async()=>{
  const {page,context}=await open();
  try {
    await page.setViewportSize({width:390,height:700});
    await upload(page,'my-notification.wav');await mute(page,'Sales').check();
    await panel(page).getByRole('button',{name:'Preview sound',exact:true}).click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    const bounds=await panel(page).boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=390 && bounds.height<=668);
    await page.screenshot({path:'test-artifacts/preferences-roles-sounds-mobile.png'});
    await page.keyboard.press('Escape');await expect(panel(page)).not.toBeVisible();
  } finally {await context.close();}
});
