import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';

const root='/app/manual-out',language=process.argv[2]||'en',date=process.argv[3]||'2026-09-29';
assert.ok(['en','zh-CN'].includes(language));
assert.match(date,/^\d{4}-\d{2}-\d{2}$/);
const name='Stock_Request_User_Manual_'+date+(language==='en'?'':'_'+language);
const validation=root+'/validation'+(language==='en'?'':'-'+language);
await mkdir(validation,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:1000,height:1300},deviceScaleFactor:1});
 const page=await context.newPage(),errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route(/^https?:/,route=>{external.push(route.request().url());return route.abort();});
 await page.goto('file://'+root+'/'+name+'.html');
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('figure img')].map(img=>img.decode()));});
 let chineseFonts=[];
 if(language==='zh-CN'){
  const session=await context.newCDPSession(page);
  await session.send('DOM.enable');await session.send('CSS.enable');
  const {root:documentNode}=await session.send('DOM.getDocument');
  const {nodeId}=await session.send('DOM.querySelector',{nodeId:documentNode.nodeId,selector:'.cover-intro h1'});
  chineseFonts=(await session.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;
  assert.ok(chineseFonts.some(font=>/WenQuanYi|Noto.*CJK/i.test(font.familyName)&&font.glyphCount>=4),'Chinese heading must render with a Chinese font');
  await session.detach();
 }
 await page.emulateMedia({media:'print'});
 const checks=await page.evaluate(()=>{
  const sections=[...document.querySelectorAll('.page')];
  const layout=sections.map(section=>{
   const body=section.querySelector('.page-body'),footer=section.querySelector('.page-footer'),area=section.getBoundingClientRect();
   const bodyBottom=body.getBoundingClientRect().bottom,footerTop=footer.getBoundingClientRect().top;
   return {page:Number(section.dataset.page),id:section.id,title:section.querySelector('h1')?.textContent,bodyBottom:Math.round(bodyBottom-area.top),footerTop:Math.round(footerTop-area.top),remaining:Math.round(footerTop-bodyBottom-8),horizontalOverflow:section.scrollWidth>section.clientWidth};
  });
  return {pages:sections.length,screenshots:document.querySelectorAll('figure img').length,layout,
   brokenImages:[...document.querySelectorAll('figure img')].filter(img=>!img.complete||!img.naturalWidth).map(img=>img.alt),
   brokenLinks:[...document.querySelectorAll('a[href^="#"]')].map(a=>a.getAttribute('href')).filter(href=>!document.getElementById(href.slice(1))),
   externalDependencies:[...document.querySelectorAll('script[src],link[href],img[src]')].map(el=>el.src||el.href).filter(url=>/^https?:/.test(url))};
 });
 const overflows=checks.layout.filter(item=>item.remaining<0||item.horizontalOverflow);
 for(const number of checks.layout.map(row=>row.page)){
  await page.locator(`.page[data-page="${number}"]`).screenshot({path:validation+`/page-${String(number).padStart(2,'0')}.png`});
 }
 await writeFile(validation+'/layout.json',JSON.stringify({...checks,errors,external,overflows},null,2)+'\n');
 console.log(JSON.stringify({pages:checks.pages,screenshots:checks.screenshots,overflows,errors,external}));
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(checks.brokenImages,[]);assert.deepEqual(checks.brokenLinks,[]);assert.deepEqual(checks.externalDependencies,[]);
 assert.deepEqual(overflows,[],'Printed content must not overlap footers or overflow pages');
 await page.pdf({path:root+'/'+name+'.pdf',format:'A4',printBackground:true,preferCSSPageSize:true,tagged:true,outline:true});
 const pdf=await readFile(root+'/'+name+'.pdf');
 const pdfPages=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;
 assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.equal(pdfPages,checks.pages,'PDF page count must match the designed manual');
 await page.emulateMedia({media:'screen'});
 await page.locator('#regular-create figure img').click();await page.locator('#imageViewer[open]').waitFor();
 assert.ok(await page.locator('#imageViewer img').evaluate(img=>img.complete&&img.naturalWidth>0));
 await page.locator('#imageViewer button').click();assert.equal(await page.locator('#imageViewer[open]').count(),0);
 await writeFile(validation+'/build.json',JSON.stringify({language,pages:pdfPages,screenshots:checks.screenshots,pdfBytes:pdf.length,...(language==='zh-CN'?{chineseFonts}:{}),checks:['No clipped pages or footer overlap','All screenshots loaded','All internal links resolved','No external dependencies or network access','No browser errors','Screenshot zoom opens and closes','PDF page count matches HTML',...(language==='zh-CN'?['Chinese glyphs use a Chinese font']:[])],verifiedAt:new Date().toISOString()},null,2)+'\n');
 console.log(JSON.stringify({pdfPages,pdfBytes:pdf.length,zoom:'passed'}));
}finally{await browser.close();}
