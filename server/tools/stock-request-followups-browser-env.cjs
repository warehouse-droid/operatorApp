// Capture real browser rendering from every regression, including nested repair pages.
require('./bin-order-workflow-browser-env.cjs');
const {chromium}=require('playwright');
const {writeFileSync}=require('node:fs');
const launch=chromium.launch.bind(chromium);let sequence=0;
chromium.launch=async options=>{
 const browser=await launch(options),instrumented=new WeakSet();
 async function instrument(page){
  if(instrumented.has(page))return page;instrumented.add(page);
  const originalStart=page.coverage.startJSCoverage.bind(page.coverage),originalStop=page.coverage.stopJSCoverage.bind(page.coverage);let running=false;
  page.coverage.startJSCoverage=async options=>{if(running)return;await originalStart({...options,resetOnNavigation:false});running=true;};
  page.coverage.stopJSCoverage=async()=>{if(!running)return [];running=false;const result=await originalStop();writeFileSync(`test-artifacts/followups-browser-${process.pid}-${sequence++}-v8.json`,JSON.stringify(result));return result;};
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  const close=page.close.bind(page);page.close=async options=>{await page.coverage.stopJSCoverage();return close(options);};return page;
 }
 const newContext=browser.newContext.bind(browser);
 browser.newContext=async options=>{const context=await newContext(options),newPage=context.newPage.bind(context),close=context.close.bind(context);
  context.newPage=async()=>instrument(await newPage());
  context.close=async options=>{for(const page of context.pages())if(!page.isClosed())await page.coverage.stopJSCoverage();return close(options);};return context;};
 const newPage=browser.newPage.bind(browser);browser.newPage=async options=>instrument(await newPage(options));
 const close=browser.close.bind(browser);browser.close=async()=>{for(const context of browser.contexts())for(const page of context.pages())if(!page.isClosed()&&instrumented.has(page))await page.coverage.stopJSCoverage();return close();};
 return browser;
};
