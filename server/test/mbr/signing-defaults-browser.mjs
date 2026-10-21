import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {app} from '../../src/server.js';
import {createOperator} from '../../src/auth-repository.js';
import {closeDb} from '../../src/db.js';
import {pdfText} from '../field-sales/pdf-text.js';
import {fields} from './fixtures.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const initialOnly=process.env.MBR_SIGNING_INITIAL_ONLY==='1';
const out=process.env.MBR_SIGNING_BROWSER_OUT || 'test-artifacts/mbr-signing-defaults/browser';
await mkdir(out,{recursive:true});
const results=[],coverage=[];
const username='signing-defaults-'+randomUUID(),password='signing-defaults-test-only';
await createOperator({username,displayName:'Signing Defaults Sales',role:'mbr_sales',password});
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
assert.equal(login.status,200);const staffToken=(await login.json()).token;
let browser;
async function api(path,{method='GET',body,publicToken}={}) {
  const response=await fetch(base+'/api/mbr'+path,{method,headers:{...(publicToken?{'x-mbr-contract-token':publicToken}:{authorization:'Bearer '+staffToken}),
    ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert.ok(response.ok,path+': '+response.status);return response.json();
}
async function issue() {
  const contract=await api('/contracts',{method:'POST',body:fields()});
  const link=await api(`/contracts/${contract.id}/link`,{method:'POST',body:{revision:1}});
  const parsed=new URL(link.url);
  return {...contract,url:base+parsed.pathname+parsed.hash,publicToken:parsed.hash.slice(1)};
}
async function check(name,fn) {
  try {await fn();results.push({name,status:'passed'});console.log('PASS',name);}
  catch(error) {
    results.push({name,status:'failed',message:error.message});console.log('FAIL',name,error.message);
    if(!initialOnly) {throw error;}
  }
}
async function draw(page) {
  const canvas=page.getByLabel('Draw your signature',{exact:true});await canvas.scrollIntoViewIfNeeded();
  const box=await canvas.boundingBox();
  const points=[[20,130],[50,50],[75,150],[120,75],[150,145],[190,100]].map(([x,y])=>({x:box.x+x,y:box.y+y}));
  await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();
  for(const point of points.slice(1)) {await page.mouse.move(point.x,point.y,{steps:3});}await page.mouse.up();
}
async function signedPdf(page,name,choice) {
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download signed PDF',exact:true}).click();
  const file=await download;await file.saveAs(`${out}/${name}.pdf`);
  const text=pdfText(await (await fetch(base+'/api/mbr/public/pdf',{headers:{'x-mbr-contract-token':new URL(page.url()).hash.slice(1)}})).arrayBuffer().then(Buffer.from));
  assert.ok(text.includes(choice+' Rental Protection Plan — 15% of applicable rental charges.'));
  assert.ok(text.includes('Full rental agreement accepted, including sections 4 and 13.'));
}
try {
  for(const [engine,width] of initialOnly?[[chromium,375]]:[[chromium,1280],[chromium,375],[webkit,390]]) {
    const name=engine.name()+'-'+width;
    browser=await engine.launch({headless:true,args:engine.name()==='chromium'?['--no-sandbox']:[]});
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    const page=await context.newPage();page.setDefaultTimeout(8000);
    const errors=[],submissions=[];page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.method()==='POST' && request.url().endsWith('/api/mbr/public/sign')) {submissions.push(request.postDataJSON());}});
    if(engine.name()==='chromium' && !initialOnly) {await page.coverage.startJSCoverage({resetOnNavigation:false});}
    const first=await issue();await page.goto(first.url);await expect(page.locator('#mbrSigningForm')).toBeVisible();
    await check(name+': signing is second and the complete rental agreement is third',async()=>{
      const sections=await page.locator('#mbrApp > section').evaluateAll(elements=>elements.map(element=>({id:element.id,title:element.querySelector('h2')?.textContent})));
      assert.equal(sections.length,3);assert.equal(sections[1].id,'signing-section');assert.equal(sections[2].title,'Rental agreement');
      assert.equal(await page.locator('.mbr-agreement h3').count(),14);
    });
    await check(name+': accept protection is the default and decline remains available',async()=>{
      assert.equal(await page.getByLabel('Accept the Rental Protection Plan',{exact:true}).isChecked(),true);
      assert.equal(await page.getByLabel('Decline the Rental Protection Plan',{exact:true}).isChecked(),false);
      assert.equal(await page.locator('[name=protection]:checked').count(),1);
    });
    await check(name+': consent is checked by default without submitting the agreement',async()=>{
      assert.equal(await page.locator('[name=consent]').isChecked(),true);assert.equal(submissions.length,0);
      assert.equal((await api('/contracts/'+first.id)).status,'pending');
    });
    if(initialOnly) {break;}
    await check(name+': a blank signature and unchecked consent still block submission',async()=>{
      await page.getByRole('button',{name:'Sign agreement',exact:true}).click();
      await expect(page.locator('#mbrNotice')).toContainText('Please draw your signature');assert.equal(submissions.length,0);
      await page.locator('[name=consent]').uncheck();await draw(page);
      await page.getByRole('button',{name:'Sign agreement',exact:true}).click();
      assert.equal(await page.locator('[name=consent]').evaluate(element=>element.validity.valueMissing),true);
      assert.equal(submissions.length,0);assert.equal((await api('/contracts/'+first.id)).status,'pending');
      await page.reload();await expect(page.locator('#mbrSigningForm')).toBeVisible();
      assert.equal(await page.locator('[name=consent]').isChecked(),true);
      assert.equal(await page.getByLabel('Accept the Rental Protection Plan',{exact:true}).isChecked(),true);
      const accessibility=await new AxeBuilder({page}).include('.mbr-wrap').analyze();assert.deepEqual(accessibility.violations,[]);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
      await page.screenshot({path:`${out}/${name}-signing-second.png`,fullPage:true});
    });
    await check(name+': untouched defaults sign as accepted and appear in the saved signature and PDF',async()=>{
      await draw(page);await page.getByRole('button',{name:'Sign agreement',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Agreement completed',exact:true})).toBeVisible({timeout:15000});
      const stored=await api('/contracts/'+first.id);
      assert.equal(stored.signature.protectionPlanAccepted,true);assert.equal(stored.signature.consent,true);
      assert.equal(submissions.at(-1).protectionPlanAccepted,true);assert.equal(submissions.at(-1).consent,true);
      assert.equal(await page.locator('#mbrSigningForm').count(),0);await signedPdf(page,name+'-accept','Accept');
    });
    await check(name+': customers can decline protection and the submitted terms and PDF record declined',async()=>{
      const second=await issue();await page.goto('about:blank');await page.goto(second.url);await expect(page.locator('#mbrSigningForm')).toBeVisible();
      await page.getByLabel('Decline the Rental Protection Plan',{exact:true}).check();await draw(page);
      await page.getByRole('button',{name:'Sign agreement',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Agreement completed',exact:true})).toBeVisible({timeout:15000});
      assert.equal((await api('/contracts/'+second.id)).signature.protectionPlanAccepted,false);
      assert.equal(submissions.at(-1).protectionPlanAccepted,false);assert.equal(submissions.at(-1).consent,true);
      await signedPdf(page,name+'-decline','Decline');
    });
    await check(name+': a stale revision resets to the requested defaults and requires a new signature',async()=>{
      const third=await issue();await page.goto('about:blank');await page.goto(third.url);await expect(page.locator('#mbrSigningForm')).toBeVisible();
      await page.getByLabel('Decline the Rental Protection Plan',{exact:true}).check();await draw(page);
      await api('/contracts/'+third.id,{method:'PATCH',body:{...fields({lessee:'Updated signing customer'}),revision:1}});
      await page.getByRole('button',{name:'Sign agreement',exact:true}).click();
      await expect(page.locator('#mbrNotice')).toContainText('agreement changed');
      await expect(page.getByText('Updated signing customer',{exact:true}).first()).toBeVisible();
      assert.equal(await page.getByLabel('Accept the Rental Protection Plan',{exact:true}).isChecked(),true);
      assert.equal(await page.locator('[name=consent]').isChecked(),true);
      const count=submissions.length;await page.getByRole('button',{name:'Sign agreement',exact:true}).click();
      await expect(page.locator('#mbrNotice')).toContainText('Please draw your signature');assert.equal(submissions.length,count);
      assert.equal((await api('/contracts/'+third.id)).status,'pending');
    });
    assert.deepEqual(errors,[]);
    if(engine.name()==='chromium') {coverage.push(...await page.coverage.stopJSCoverage());}
    await context.close();await browser.close();browser=null;
  }
  if(results.some(result=>result.status==='failed')) {process.exitCode=1;}
} finally {
  await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
  await writeFile(`${out}/coverage.json`,JSON.stringify(coverage));
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();
}
