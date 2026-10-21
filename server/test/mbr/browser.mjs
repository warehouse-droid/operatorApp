import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {app} from '../../src/server.js';
import {createOperator} from '../../src/auth-repository.js';
import {query,closeDb} from '../../src/db.js';
import {fields} from './fixtures.js';

const OUT=process.env.MBR_BROWSER_ARTIFACTS || 'test-artifacts/mbr-contract/browser';
assert.equal(process.env.MBT_TEST_ISOLATED,'1','Run browser tests through mbr-contract-gauntlet.py');
await mkdir(OUT,{recursive:true});
const username='mbr-phone-'+randomUUID(),password='mbr-phone-tests';
await createOperator({username,displayName:'Phone MBR Sales',password,role:'mbr_sales'});
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const results=[],coverage=[];
let browser;
async function check(name,fn) {await fn();results.push({name,status:'passed'});console.log('PASS',name);}
async function api(path,{token,method='GET',body}={}) {
  const response=await fetch(base+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),
    ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const payload=await response.json();assert.ok(response.ok,payload.error);return payload;
}
async function noOverflow(page) {
  const dimensions=await page.evaluate(()=>({width:window.innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(dimensions.scroll<=dimensions.width+1,JSON.stringify(dimensions));
  const controls=await page.locator('input:not([type=radio]):not([type=checkbox]),select,button').evaluateAll(elements=>elements.filter(element=>element.getBoundingClientRect().width>0).map(element=>({
    name:element.getAttribute('name') || element.textContent.trim(),height:element.getBoundingClientRect().height,font:parseFloat(window.getComputedStyle(element).fontSize)})));
  for(const control of controls) {
    assert.ok(control.height>=44,`Small control ${control.name}: ${control.height}`);
    if(control.name!=='Close module menu') {assert.ok(control.font>=14,`Small control font: ${control.name}`);}
  }
}
async function accessibility(page,name) {
  const result=await new AxeBuilder({page}).include('.mbr-wrap').analyze();
  await writeFile(`${OUT}/${name}-axe.json`,JSON.stringify(result.violations,null,2));
  assert.deepEqual(result.violations.map(item=>({id:item.id,impact:item.impact,nodes:item.nodes.map(node=>node.target)})),[]);
}
async function fillEditor(page,name) {
  await page.getByLabel('Equipment model',{exact:true}).selectOption('STR1000H');
  await page.getByLabel('Serial number',{exact:true}).selectOption('VLGST1KHAT0610007');
  for(const [label,value] of Object.entries({'Effective date':'2026-10-13','Lessee / company':name,
    'Rental start date':'2026-10-15','Rental end date':'2026-10-22',
    'Pickup location':'90 Belfield Road, Toronto','Return location':'90 Belfield Road, Toronto',
    'Daily rate (CAD)':'250.00','Weekly rate (CAD)':'1000.00','Monthly rate (CAD)':'3000.00','Refundable deposit (CAD)':'500.00'})) {
    await page.getByLabel(label,{exact:true}).fill(value);
  }
}
async function draw(page,finger=false) {
  const canvas=page.getByLabel('Draw your signature',{exact:true});await canvas.scrollIntoViewIfNeeded();
  const bounds=await canvas.boundingBox();
  const points=[[20,130],[50,50],[75,150],[120,75],[150,145],[190,100]].map(([x,y])=>({x:bounds.x+x,y:bounds.y+y}));
  if(finger) {
    const session=await page.context().newCDPSession(page);
    const touches=point=>[{...point,id:1,radiusX:4,radiusY:4,force:1}];
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touches(points[0])});
    for(const point of points.slice(1)) {await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touches(point)});}
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await session.detach();
  } else {
    await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();
    for(const point of points.slice(1)) {await page.mouse.move(point.x,point.y,{steps:3});}await page.mouse.up();
  }
}

try {
  for(const [engine,width] of [[chromium,375],[webkit,390]]) {
    const name=engine.name();browser=await engine.launch({headless:true,args:name==='chromium'?['--no-sandbox']:[]});
    const staff=await browser.newContext({viewport:{width,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'});
    const page=await staff.newPage();page.setDefaultTimeout(7000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    if(name==='chromium') {await page.coverage.startJSCoverage({resetOnNavigation:false});}
    await check(`${name}: real MBR Sales login on a phone`,async()=>{
      await page.goto(base+'/');await page.getByLabel('Username',{exact:true}).fill(username);await page.getByLabel('Password',{exact:true}).fill(password);
      await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL(base+'/mbr/contracts');
      await expect(page.getByRole('heading',{name:'Contracts',exact:true})).toBeVisible();await noOverflow(page);
    });
    let id,link,token;
    await check(`${name}: phone-friendly sales creation, fields and link generation`,async()=>{
      await page.getByRole('link',{name:'New contract',exact:true}).click();await fillEditor(page,'Phone Customer '+name);
      await noOverflow(page);await accessibility(page,name+'-sales');
      await page.screenshot({path:`${OUT}/${name}-sales-editor.png`,fullPage:true});
      await page.getByRole('button',{name:'Save contract',exact:true}).click();await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeVisible();
      id=new URL(page.url()).pathname.split('/').at(-1);
      await page.getByRole('button',{name:'Generate signing link',exact:true}).click();await expect(page.getByLabel('Customer signing link')).toBeVisible();
      link=await page.getByLabel('Customer signing link').inputValue();
      await expect(page.getByRole('button',{name:'Copy signing link',exact:true})).toBeVisible();
      await noOverflow(page);token=await page.evaluate(()=>localStorage.getItem('mbbs.staff.token'));
    });
    const customer=await browser.newContext({viewport:{width,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'});
    const signing=await customer.newPage();signing.setDefaultTimeout(7000);const publicErrors=[];
    signing.on('pageerror',error=>publicErrors.push(error.message));
    if(name==='chromium') {await signing.coverage.startJSCoverage({resetOnNavigation:false});}
    await check(`${name}: customer reviews complete agreement without an account`,async()=>{
      await signing.goto(link);await expect(signing.getByRole('heading',{name:'Choose protection & sign',exact:true})).toBeVisible();
      assert.equal(await signing.evaluate(()=>localStorage.getItem('mbbs.staff.token')),null);
      await expect(signing.getByText('Phone Customer '+name,{exact:true}).first()).toBeVisible();await noOverflow(signing);
      assert.equal(await signing.locator('.mbr-agreement h3').count(),14);await accessibility(signing,name+'-customer');
      await signing.screenshot({path:`${OUT}/${name}-customer-review.png`,fullPage:true});
      assert.equal(await signing.getByLabel('Accept the Rental Protection Plan',{exact:true}).isChecked(),true);
      assert.equal(await signing.locator('[name=consent]').isChecked(),true);
    });
    if(name==='chromium') {
      await check('chromium: stale customer sees updated terms with default choices and a cleared signature',async()=>{
        await signing.getByLabel('Accept the Rental Protection Plan',{exact:true}).check();await signing.getByLabel('Signer name',{exact:true}).fill('Alice Customer');
        await signing.getByLabel('I have reviewed and agree',{exact:false}).check();await draw(signing,true);
        await api('/api/mbr/contracts/'+id,{token,method:'PATCH',body:{revision:1,...fields({lessee:'Updated Customer',dailyRate:'270.00'})}});
        await signing.getByRole('button',{name:'Sign agreement',exact:true}).click();await expect(signing.locator('#mbrNotice')).toContainText('agreement changed');
        assert.equal(await signing.getByLabel('Accept the Rental Protection Plan',{exact:true}).isChecked(),true);
        assert.equal(await signing.locator('[name=consent]').isChecked(),true);
        await expect(signing.getByText('Updated Customer',{exact:true}).first()).toBeVisible();
      });
    }
    await check(`${name}: ${name==='chromium'?'finger':'mouse'} signature survives a network failure and then completes`,async()=>{
      await signing.getByLabel('Decline the Rental Protection Plan',{exact:true}).check();await signing.getByLabel('Signer name',{exact:true}).fill('Alice Customer');
      await signing.getByLabel('I have reviewed and agree',{exact:false}).check();await draw(signing,name==='chromium');
      await customer.route('**/api/mbr/public/sign',route=>route.abort('failed'));
      await signing.getByRole('button',{name:'Sign agreement',exact:true}).click();await expect(signing.locator('#mbrNotice')).toContainText('signature');
      assert.equal(await signing.locator('[name=consent]').isChecked(),true);assert.equal(await signing.locator('[name=protection]:checked').count(),1);
      await customer.unroute('**/api/mbr/public/sign');await signing.getByRole('button',{name:'Sign agreement',exact:true}).click();
      await expect(signing.getByRole('heading',{name:'Agreement completed',exact:true})).toBeVisible({timeout:15000});
      await expect(signing.getByText('Declined',{exact:true})).toBeVisible();await noOverflow(signing);await accessibility(signing,name+'-completed');
      await signing.screenshot({path:`${OUT}/${name}-completed.png`,fullPage:true});
      const downloadEvent=signing.waitForEvent('download');await signing.getByRole('button',{name:'Download signed PDF',exact:true}).click();
      const download=await downloadEvent;await download.saveAs(`${OUT}/${name}-signed-contract.pdf`);assert.ok(download.suggestedFilename().endsWith('.pdf'));
      await query("UPDATE mbr_contracts SET expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[id]);
      await signing.reload();await expect(signing.getByRole('heading',{name:'Agreement completed',exact:true})).toBeVisible();
    });
    await check(`${name}: shared sales list and explicit expired renewal work on phones`,async()=>{
      await page.goto(base+'/mbr/contracts');await page.getByLabel('Search contracts',{exact:true}).fill('Phone Customer');
      await page.getByRole('button',{name:'Search',exact:true}).click();await expect(page.locator('.mbr-contract-card').first()).toBeVisible();await noOverflow(page);
      const expiring=await api('/api/mbr/contracts',{token,method:'POST',body:fields({lessee:'Renew on phone '+name})});
      const old=await api(`/api/mbr/contracts/${expiring.id}/link`,{token,method:'POST',body:{revision:1}});
      await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[expiring.id]);
      await page.goto(base+'/mbr/contracts/'+expiring.id);await expect(page.getByRole('button',{name:'Renew & generate link',exact:true})).toBeVisible();
      await noOverflow(page);await page.getByRole('button',{name:'Renew & generate link',exact:true}).click();await expect(page.getByLabel('Customer signing link')).toBeVisible();
      const renewed=await page.getByLabel('Customer signing link').inputValue();assert.notEqual(new URL(renewed).hash,new URL(old.url).hash);
      assert.equal((await api('/api/mbr/contracts/'+expiring.id,{token})).revision,2);
    });
    assert.deepEqual(errors,[]);assert.deepEqual(publicErrors,[]);
    if(name==='chromium') {coverage.push(...await page.coverage.stopJSCoverage(),...await signing.coverage.stopJSCoverage());}
    await staff.close();await customer.close();await browser.close();browser=null;
  }
} catch(error) {
  results.push({name:'browser execution',status:'failed',message:error.message});throw error;
} finally {
  await writeFile(`${OUT}/results.json`,JSON.stringify(results,null,2));
  await writeFile(`${OUT}/coverage.json`,JSON.stringify(coverage));
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();
}
