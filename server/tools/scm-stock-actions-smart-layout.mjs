import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium,expect} from '@playwright/test';

const directory='test-artifacts/scm-stock-actions-20261006';
const checkedFiles=['public/scm-smart.js','public/scm-smart.html','public/scm-smart.css','public/scm-smart-proposals.css','public/scm-smart-vendor.css','public/scm-smart-blanket.css','public/scm-smart-exclusions.css'];
const sourceHashes=Object.fromEntries(await Promise.all(checkedFiles.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
const measurements=[];
try{
  await mkdir(directory,{recursive:true});
  async function open(width,{baseline=false,collapsed=false}={}){
    const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
    await context.addInitScript(isCollapsed=>{
      localStorage.setItem('mbbs.staff.token','smart-width-test');
      localStorage.setItem('mbbs.appSidebar.collapsed',String(isCollapsed));
      window.EventSource=class extends EventTarget{close(){}};
    },collapsed);
    const page=await context.newPage();page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path.startsWith('/api/')){
        assert.equal(route.request().method(),'GET','Layout preview must not write data');
        if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'width-test',display_name:'SCM',role:'scm',roles:['scm'],yardLocationIds:[1,28,15,26]}}});
        if(path==='/api/navigation/menu-order')return route.fulfill({json:{revision:4,orders:{}}});
        if(path==='/api/scm/smart/bootstrap')return route.fulfill({json:{settings:{executionMode:'shadow'},yards:[],vendorYards:[],syncStatus:{inventoryStatus:'ready',inventoryItemCount:10},latestRun:{id:1,status:'completed',revision:1,proposals:[],totals:{}},planningRuns:[],latestForecasts:[],vendorReplyLoads:[]}});
        return route.fulfill({json:{requests:[],count:0,total:0,unread:0,orders:[],enabled:true}});
      }
      const file=path==='/scm/smart'?'/scm-smart.html':path;
      try{
        const body=await readFile(baseline&&file==='/scm-smart.css'?'/app/stock-view-before/public/scm-smart.css':'public'+file);
        return route.fulfill({body,contentType:({js:'application/javascript',css:'text/css',html:'text/html',svg:'image/svg+xml'})[file.split('.').at(-1)]||'application/octet-stream'});
      }catch{return route.fulfill({status:404,body:''});}
    });
    await page.goto('http://localhost/scm/smart');
    await expect(page.locator('.smart-section-head h2').first()).toHaveText('Controlled planning cycle');
    await expect(page.locator('#appSidebar')).toBeVisible();
    await page.waitForLoadState('networkidle');
    return {context,page,errors};
  }
  async function measure(page){return page.evaluate(()=>{
    const body=getComputedStyle(document.body),main=document.querySelector('.smart-main').getBoundingClientRect();
    const sidebar=parseFloat(body.paddingLeft);
    return {viewport:window.innerWidth,sidebar,left:main.left,width:main.width,right:main.right,
      sections:[...document.querySelectorAll('.smart-main .smart-section')].map(section=>{const r=section.getBoundingClientRect();return {left:r.left,width:r.width,right:r.right};})};
  });}
  for(const width of [2560,1920,1440,600]){
    const f=await open(width,{collapsed:width<700});
    try{
      let currentCollapsed=width<700;
      for(const collapsed of width<700?[true]:[false,true]){
        if(collapsed!==currentCollapsed){await f.page.locator('[data-sidebar-toggle]').click();await f.page.waitForTimeout(200);currentCollapsed=collapsed;}
        for(const tab of ['overview','plans','settings']){
          await f.page.locator(`[data-smart-tab="${tab}"]`).click();
          await expect(f.page.locator('.smart-main .smart-section').first()).toBeVisible();
          for(const percent of [100,80,160]){
            let current=Number((await f.page.locator('[data-smart-font-value]').textContent()).replace('%',''));
            while(current!==percent){await f.page.getByRole('button',{name:percent>current?'Increase font size':'Decrease font size'}).click();current+=percent>current?10:-10;}
            await f.page.waitForFunction(()=>Math.abs(parseFloat(getComputedStyle(document.querySelector('.smart-tabs')).top)-Math.ceil(document.querySelector('.dispatch-topbar').getBoundingClientRect().height))<1);
            const result=await measure(f.page);
            const type=await f.page.locator('.smart-brand h1').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
            assert.ok(Math.abs(type-19*percent/100)<0.02);
            assert.ok(Math.abs(result.left-(result.sidebar+15))<1,JSON.stringify(result));
            assert.ok(Math.abs(result.right-(width-15))<1,JSON.stringify(result));
            assert.ok(result.sections.length>0);
            for(const section of result.sections){assert.ok(Math.abs(section.left-result.left)<1);assert.ok(Math.abs(section.width-result.width)<1);}
            measurements.push({tab,collapsed,percent,headingFontSize:type,...result});
            if(tab==='overview'&&[2560,600].includes(width)&&percent===160)await f.page.screenshot({path:`${directory}/smart-font-${width}-${collapsed?'collapsed':'expanded'}-160.png`,fullPage:true});
          }
        }
      }
      assert.deepEqual(f.errors,[]);
    }finally{await f.context.close();}
  }
  await writeFile(`${directory}/smart-font-layout.json`,JSON.stringify({passed:true,at:new Date().toISOString(),sourceHashes,measurements},null,2));
  console.log(JSON.stringify({passed:true,layoutChecks:measurements.length,fontSizes:[80,100,160],desktopAndNarrowViewports:true}));
}finally{await browser.close();}
