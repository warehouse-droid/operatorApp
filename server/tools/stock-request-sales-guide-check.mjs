// Validate the standalone guide using an offline browser.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
const out='/app/manual-out',art='/app/check-out';
await mkdir(art,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();
 const errors=[],external=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route(/^https?:/,route=>{external.push(route.request().url());return route.abort();});
 await page.goto('file://'+out+'/Stock_Request_Sales_Guide_2026-09-30_zh-CN.html');
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('figure img')].map(image=>image.decode()));});
 const result=await page.evaluate(()=>({
  language:document.documentElement.lang,sections:document.querySelectorAll('.guide-section').length,
  screenshots:document.querySelectorAll('figure img').length,
  brokenImages:[...document.querySelectorAll('figure img')].filter(image=>!image.complete||!image.naturalWidth).map(image=>image.alt),
  brokenLinks:[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.getElementById(a.hash.slice(1))).map(a=>a.hash),
  externalDependencies:[...document.querySelectorAll('script[src],link[href],img[src]')].map(element=>element.src||element.href).filter(url=>/^https?:/.test(url)),
  text:document.querySelector('main').innerText
 }));
 assert.equal(result.language,'zh-CN');assert.equal(result.sections,16);
 assert.deepEqual(result.brokenImages,[]);assert.deepEqual(result.brokenLinks,[]);assert.deepEqual(result.externalDependencies,[]);
 assert.match(result.text,/不检查安全库存阈值/);assert.match(result.text,/Target Yard → Base Yard/);assert.match(result.text,/SOB121732/);
 assert.match(result.text,/Request adjustment/);assert.match(result.text,/Request closure/);
 assert.doesNotMatch(result.text,/Smart SCM → Settings|Create PO in NetSuite|Confirm adjustment（确认调整）|提交自取或备货申请|SCM internal note/);
 const sizes=[];
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  const layout=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,
   overflow:[...document.querySelectorAll('.guide-section,figure,table')].filter(el=>el.getBoundingClientRect().right>innerWidth+1||el.getBoundingClientRect().left<0).map(el=>el.id||el.tagName)}));
  assert.ok(layout.documentWidth<=width);assert.deepEqual(layout.overflow,[]);sizes.push(layout);
  await page.screenshot({path:art+`/cover-${width}.png`});
 }
 await page.setViewportSize({width:1440,height:1000});
 for(const id of ['delivery-approval','special-follow','special-adjustment','special-close'])await page.locator('#'+id).screenshot({path:art+'/'+id+'.png'});
 await page.locator('#delivery-create figure img').focus();await page.keyboard.press('Enter');
 await page.locator('#imageViewer[open]').waitFor();assert.ok(await page.locator('#imageViewer img').evaluate(image=>image.naturalWidth>0));
 await page.keyboard.press('Escape');assert.equal(await page.locator('#imageViewer[open]').count(),0);
 await page.locator('.topbar a[href="#special-header"]').click();assert.equal(new URL(page.url()).hash,'#special-header');
 await page.emulateMedia({media:'print'});assert.equal(await page.locator('.topbar').isVisible(),false);assert.equal(await page.locator('.toc').isVisible(),false);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const summary={language:result.language,sections:result.sections,screenshots:result.screenshots,errors,external,sizes,
  checks:['Chinese Sales-only content','Delivery safety-stock exemption and quantity rules','Special Sales actions and follow-up','All images loaded','Internal links resolve','Desktop and mobile fit','Keyboard image zoom and Escape','Navigation links work','Print controls hidden','No external dependencies or network requests']};
 await writeFile(art+'/validation.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
}finally{await browser.close();}
