import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {app} from '../../../src/server.js';
import {closeDb} from '../../../src/db.js';
let server,browser,base;
before(async()=>{
 server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});await fs.mkdir('test-artifacts/staff-login-reset-20261003/browser',{recursive:true});
});
after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();});
test('all staff module entry points share the login page while Driver remains separate',async()=>{
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 for(const path of ['/dispatch','/scm','/sales','/boss','/control','/admin/accounts','/operator','/delivery','/field-sales/']){
  await page.coverage.startJSCoverage({resetOnNavigation:false});await page.goto(base+path);await page.waitForURL('**/login.html?next=**',{timeout:10000});
  assert.equal(await page.getByRole('heading',{name:'Staff login'}).count(),1,path);await fs.writeFile('test-artifacts/staff-login-reset-20261003/browser/'+path.replaceAll('/','-')+'-coverage.json',JSON.stringify(await page.coverage.stopJSCoverage()));
 }
 await page.goto(base+'/driver');await page.waitForSelector('[data-form="login"]');
 assert.equal(new URL(page.url()).pathname,'/driver');assert.equal(await page.getByRole('heading',{name:'Staff login'}).count(),0);
 await context.close();
});
test('Field Sales shares staff authentication and failed staff login never calls driver login',async()=>{
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();let driverCalls=0;
 await page.route('**/api/driver/login',route=>{driverCalls++;return route.fulfill({status:401,json:{error:'bad'}});});
 await page.route('**/api/auth/login',route=>route.fulfill({status:401,json:{error:'Invalid username or password.'}}));
 await page.goto(base+'/login.html');await page.getByLabel('Username',{exact:true}).fill('staff');await page.getByLabel('Password',{exact:true}).fill('bad-password');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(driverCalls,0);
 await page.route('**/api/auth/login',route=>route.fulfill({json:{token:'staff-token',operator:{role:'field_sales',roles:['field_sales'],homeRoute:'/field-sales/'}}}));
 await page.route('**/field-sales/',route=>route.fulfill({contentType:'text/html',body:'<h1>Field Sales destination</h1>'}));
 await page.getByLabel('Username',{exact:true}).fill('staff');await page.getByLabel('Password',{exact:true}).fill('valid-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.waitForURL('**/field-sales/');assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.staff.token')),'staff-token');
 await context.close();
});
test('numeric code, leading zeroes, expiry and resend timers work on a phone',async()=>{
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage();
 await page.coverage.startJSCoverage({resetOnNavigation:false});await page.clock.install();await page.clock.pauseAt(new Date());let sends=0,verified,completed;
 await page.route('**/api/auth/password-reset/request',route=>{sends++;return route.fulfill({json:{challengeId:'11111111-1111-4111-8111-111111111111',expiresIn:60,retryAfter:20}});});
 await page.route('**/api/auth/password-reset/verify',route=>{verified=route.request().postDataJSON();return route.fulfill({json:{resetToken:'test-proof'}});});
 await page.route('**/api/auth/password-reset/complete',route=>{completed=route.request().postDataJSON();return route.fulfill({json:{ok:true}});});
 await page.goto(base+'/login.html');await page.getByRole('button',{name:'Forgot password?'}).click();
 await page.getByLabel('Username',{exact:true}).fill('staff');await page.getByLabel('Account email').fill('staff@example.test');await page.getByRole('button',{name:'Send code',exact:true}).click();
 const code=page.getByLabel('6-digit code');await code.waitFor();assert.equal(await code.getAttribute('inputmode'),'numeric');
 await code.fill('a04b2817');assert.equal(await code.inputValue(),'042817');
 assert.equal(await page.getByRole('button',{name:/Resend/}).isDisabled(),true);await page.clock.fastForward(19999);assert.equal(await page.getByRole('button',{name:/Resend/}).isDisabled(),true);
 await page.clock.fastForward(1001);assert.equal(await page.getByRole('button',{name:'Resend code',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'Resend code',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[name=passcode]')?.value==='');assert.equal(sends,2);await code.fill('042817');
 for(const width of [320,390,430]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await page.screenshot({path:'test-artifacts/staff-login-reset-20261003/browser/numeric-code.png'});
 await page.clock.fastForward(60000);assert.equal(await page.getByRole('button',{name:'Verify code',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Resend code',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[name=passcode]')?.value==='');await code.fill('042817');await page.getByRole('button',{name:'Verify code',exact:true}).click();
 await page.getByLabel('New password',{exact:true}).fill('new-password');await page.getByLabel('Confirm password',{exact:true}).fill('new-password');await page.getByRole('button',{name:'Reset password',exact:true}).click();
 await page.getByText('Password updated. Sign in with your new password.').waitFor();assert.equal(verified.passcode,'042817');assert.equal(completed.password,'new-password');await fs.writeFile('test-artifacts/staff-login-reset-20261003/browser/reset-coverage.json',JSON.stringify(await page.coverage.stopJSCoverage()));
 await context.close();
});
