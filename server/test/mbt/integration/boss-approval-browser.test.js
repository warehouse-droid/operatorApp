import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import {chromium} from 'playwright';
import {app} from '../../../src/server.js';
import {createOperator,loginOperator,getOperatorByToken} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import {createBossRepository} from '../../../src/boss-approval-repository.js';
import {createBossApprovalRouter} from '../../../src/boss-approval-router.js';
import {createBossApprovalService} from '../../../src/boss-approval-service.js';
let server,browser,base,repo,service;const people=[],snapshots=new Map();let admin;
const directory='test-artifacts/boss-approvals/browser';
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');await fs.mkdir(directory,{recursive:true});
 await query('TRUNCATE boss_approval_notifications,boss_approval_events,boss_approval_commands,boss_approval_requests,boss_approval_sources RESTART IDENTITY');
 await query('UPDATE boss_approval_principals SET operator_id=NULL,owner_id=NULL');
 await query('UPDATE boss_approval_settings SET enabled=false,revision=1');repo=createBossRepository();
 for(const [index,key] of ['tony_tan','jason_pu','alex_huang'].entries()){
  const username=`boss-browser-${crypto.randomUUID()}`;
  const person=await createOperator({username,displayName:key,role:'boss',email:`${key}@example.test`,password:'isolated-browser-test'});
  const login=await loginOperator(username,'isolated-browser-test');people.push({...person,token:login.token,key,ownerId:String(index+1)});
 }
 const username=`boss-browser-admin-${crypto.randomUUID()}`;await createOperator({username,role:'admin',password:'isolated-browser-test'});admin=await loginOperator(username,'isolated-browser-test');
 await repo.configure({revision:1,enabled:true,principals:people.map(p=>({key:p.key,operatorId:p.id,ownerId:p.ownerId}))},admin.operator.id);
 for(const [id,ownerId] of [[980001,null],[980002,'2']]){
  const s={orderId:id,tranid:`SO${id}`,customerId:77,customerName:id===980001?'Acme Construction Ltd.':'Jason only customer',status:'A',ownerId,creditLimit:'100000',balance:'125450.25',unbilledOrders:'2000.25',currency:'CAD',orderVersion:'v1'};
  snapshots.set(id,s);await repo.observe({orderType:'sales_order',netsuiteOrderId:id,tranid:s.tranid,status:'A'});await repo.applySource(await repo.claimSource(),s);
 }
 // Substitute only the NetSuite network boundary. Browser, HTTP, auth, decisions,
 // PostgreSQL and notifications all run their production implementations.
 const remote={read:async id=>snapshots.get(id),approve:async id=>{snapshots.get(id).status='B';},close:async id=>{snapshots.get(id).status='H';}};
 service=createBossApprovalService({repo,remote});
 const outer=express();outer.use(express.json());outer.use('/api/boss',async(req,res,next)=>{
  req.operator=await getOperatorByToken(String(req.headers.authorization||'').replace(/^Bearer /,''));
  if(!req.operator){return res.status(401).json({error:'Sign in'});}next();
 },createBossApprovalRouter({repo,service}));outer.use(app);
 server=outer.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await closeDb();});
async function pageFor(person,width=390){
 const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1});
 await context.addInitScript(({token,role})=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.staff.role',role);localStorage.setItem('mbbs.staff.roles',JSON.stringify([role]));},{token:person.token,role:person.role||person.operator?.role});
 const page=await context.newPage();await page.coverage.startJSCoverage({resetOnNavigation:false});return {page,context};
}
async function closePage(page,context,name){await fs.writeFile(`${directory}/${name}-coverage.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}
test('phone layouts at 320, 390 and 430px show credit, accessible colored buttons, owner-only cards and confirmation',async()=>{
 for(const width of [320,390,430]){
  const {page,context}=await pageFor(people[0],width);await page.goto(base+'/boss');await page.getByText('Acme Construction Ltd.').waitFor();
  assert.equal(await page.getByText('Jason only customer').count(),0);
  assert.equal(await page.getByText('100,000.00',{exact:true}).count(),1);assert.equal(await page.getByText('125,450.25',{exact:true}).count(),1);
  for(const [name,color] of [['Accept','rgb(21, 128, 61)'],['Reject','rgb(185, 28, 28)']]){
   const button=page.getByRole('button',{name,exact:true});assert((await button.boundingBox()).height>=48);
   assert.deepEqual(await button.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color})),{bg:color,color:'rgb(255, 255, 255)'});
  }
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'Reject',exact:true}).click();await page.getByRole('dialog').waitFor();assert.equal(await page.getByRole('dialog').locator('textarea,input').count(),0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.screenshot({path:`${directory}/phone-${width}.png`,fullPage:true});
  await closePage(page,context,`phone-${width}`);
 }
});
test('three financial figures agree in the card and confirmation, and header plus search stay visible while scrolling',async()=>{
 for(const width of [320,390,430]){
  const {page,context}=await pageFor(people[0],width);await page.goto(base+'/boss');await page.getByText('Acme Construction Ltd.').waitFor();
  const card=page.locator('.boss-card').first();
  assert.equal(await card.getByText('Account Credit',{exact:true}).count(),1);assert.equal(await card.getByText('Current Owed',{exact:true}).count(),1);assert.equal(await card.getByText('Credit Balance',{exact:true}).count(),1);
  assert.equal(await card.getByText('-127,450.50',{exact:true}).count(),1);assert.equal(await card.getByText('-27,450.50',{exact:true}).count(),1);
  assert.equal(await card.getByText('2,000.25',{exact:true}).count(),1);
  await page.evaluate(()=>{const source=document.querySelector('.boss-card');for(let i=0;i<5;i++){source.parentNode.append(source.cloneNode(true));}window.scrollTo(0,600);});
  await page.waitForFunction(()=>window.scrollY>=500);
  for(const locator of [page.locator('.boss-header'),page.getByRole('tablist'),page.locator('#searchForm')]){
   const box=await locator.boundingBox();assert(box.y>=0&&box.y+box.height<=844);
  }
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${directory}/sticky-${width}.png`,fullPage:false});
  await page.evaluate(()=>window.scrollTo(0,0));await card.getByRole('button',{name:'Accept',exact:true}).click();
  assert.equal(await page.getByRole('dialog').getByText('-127,450.50',{exact:true}).count(),1);assert.equal(await page.getByRole('dialog').getByText('-27,450.50',{exact:true}).count(),1);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await closePage(page,context,`credit-sticky-${width}`);
 }
});
test('Reject uses an in-app confirmation, closes through the worker and shares verified history',async()=>{
 const {page,context}=await pageFor(people[0]);let browserDialogs=0,writes=0;
 page.on('dialog',async native=>{browserDialogs++;await native.dismiss();});page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/decision')){writes++;}});
 await page.goto(base+'/boss');await page.getByRole('button',{name:'Reject',exact:true}).click();
 const popup=page.getByRole('dialog');await popup.getByText('Close this sales order in NetSuite.',{exact:false}).waitFor();
 assert.equal(await popup.locator('input,textarea').count(),0);await popup.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(writes,0);assert.equal(snapshots.get(980001).status,'A');
 await page.getByRole('button',{name:'Reject',exact:true}).click();await page.screenshot({path:directory+'/reject-confirmation.png'});
 await page.getByRole('button',{name:'Reject and close order',exact:true}).click();await page.getByText('Checking NetSuite',{exact:true}).waitFor();assert.equal(snapshots.get(980001).status,'A');
 const command=await repo.claimCommand();assert(command);await service.processCommand(command);assert.equal(writes,1);assert.equal(browserDialogs,0);
 await page.getByRole('heading',{name:'All caught up'}).waitFor();assert.equal(snapshots.get(980001).status,'H');
 await page.getByRole('tab',{name:'History',exact:true}).click();await page.getByText('Closed in NetSuite.').waitFor();await page.getByRole('button',{name:'View approval history'}).click();await page.getByRole('dialog').waitFor();
 await closePage(page,context,'rejection');
 const other=await pageFor(people[2]);await other.page.goto(base+'/boss');await other.page.getByRole('tab',{name:'History',exact:true}).click();await other.page.getByText('Acme Construction Ltd.').waitFor();
 await other.page.getByRole('button',{name:/Notifications/}).click();const notice=other.page.getByRole('button',{name:/SO980001 · Rejected/});await notice.click();await other.page.getByRole('dialog').getByRole('heading',{name:'SO980001'}).waitFor();
 const notifications=await repo.notifications(people[2]);assert(notifications.notifications.find(n=>n.kind==='rejected_closed').readAt);
 await closePage(other.page,other.context,'history');
});
test('Accept waits for native read-back and offline mode prevents a decision',async()=>{
 const {page,context}=await pageFor(people[1]);await page.goto(base+'/boss');await page.getByText('Jason only customer').waitFor();
 await context.setOffline(true);await page.getByText('You are offline.',{exact:false}).waitFor();assert(await page.getByRole('button',{name:'Accept',exact:true}).isDisabled());await context.setOffline(false);
 await page.getByRole('button',{name:'Accept',exact:true}).click();await page.getByRole('button',{name:'Accept order',exact:true}).click();await page.getByText('Checking NetSuite',{exact:true}).waitFor();
 const command=await repo.claimCommand();assert(command);await service.processCommand(command);
 await page.getByRole('heading',{name:'All caught up'}).waitFor();await page.getByRole('tab',{name:'History',exact:true}).click();await page.getByText('Jason only customer').waitFor();
 assert.equal(snapshots.get(980002).status,'B');await closePage(page,context,'accept');
});
test('Accounts includes email and BOSS authority; setup is reviewable',async()=>{
 const {page,context}=await pageFor(admin,1280);page.on('dialog',dialog=>dialog.accept());await page.goto(base+'/admin/accounts');
 await page.getByRole('button',{name:'+ New User',exact:true}).click();await page.locator('#newEmail').fill('new.boss@example.test');await page.locator('#newRole').selectOption('boss');
  assert.equal(await page.locator('#newRole').inputValue(),'boss');
  const username=`boss-browser-created-${crypto.randomUUID()}`;
  await page.locator('#newUsername').fill(username);await page.locator('#newDisplayName').fill('BOSS email test');await page.locator('#newPassword').fill('isolated-browser-test');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  const email=page.locator('[data-form="account-email"] input[name="email"]');await email.waitFor();assert.equal(await email.inputValue(),'new.boss@example.test');
  await email.fill('edited.boss@example.test');const saved=page.waitForResponse(response=>response.url().endsWith('/email')&&response.request().method()==='PUT');await page.getByRole('button',{name:'Save email',exact:true}).click();assert.equal((await saved).status(),200);
  assert.equal((await query('SELECT email FROM operators WHERE username=$1',[username])).rows[0].email,'edited.boss@example.test');
  await fs.writeFile(`${directory}/accounts-edit-coverage.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.goto(base+'/admin/boss-approvals');await page.getByRole('heading',{name:'BOSS approval setup'}).waitFor();assert.equal(await page.getByText('MBBS System',{exact:true}).count(),1);
  const setupSaved=page.waitForResponse(response=>response.url().endsWith('/api/admin/boss-approvals')&&response.request().method()==='PUT');await page.getByRole('button',{name:'Save setup',exact:true}).click();assert.equal((await setupSaved).status(),200);await page.getByText('BOSS approval setup saved.',{exact:true}).waitFor();
 await page.screenshot({path:`${directory}/admin-setup.png`,fullPage:true});await closePage(page,context,'accounts');
});
test('BOSS signs in on the main login page and restricted modules redirect to approvals',async()=>{
 const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();
 await page.coverage.startJSCoverage({resetOnNavigation:false});await page.goto(base+'/');
 await page.locator('input[name="username"]').fill(people[0].username);await page.locator('input[name="password"]').fill('isolated-browser-test');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(base+'/boss');await page.getByRole('heading',{name:'Sales approvals'}).waitFor();
 await fs.writeFile(`${directory}/login-coverage.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await page.coverage.startJSCoverage({resetOnNavigation:false});
 await page.goto(base+'/admin/accounts');await page.waitForURL(base+'/boss');await page.getByRole('heading',{name:'Sales approvals'}).waitFor();
 await page.goto(base+'/admin/boss-approvals');await page.waitForURL(base+'/boss');await page.getByRole('heading',{name:'Sales approvals'}).waitFor();
 await closePage(page,context,'role-redirect');
});
