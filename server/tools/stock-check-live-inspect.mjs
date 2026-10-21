// Read-only operational diagnosis: no cart or shipment mutations, no credential/cookie output.
import {chromium} from 'playwright';
import {createStockCheckRuntime} from '/app/src/stock-check/runtime.js';
import {readPortalDocument} from '/app/src/stock-check/unilock-dom.js';
import {closeDb} from '/app/src/db.js';
const runtime=createStockCheckRuntime({authenticate:(_req,_res,next)=>next(),dataDir:'/app/data'});
const credentials=await runtime.repo.getCredentials(1,1),browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
try {
  const page=await browser.newPage();await page.goto('https://ontario.order.unilock.com/login.aspx',{waitUntil:'domcontentloaded'});
  await page.locator('#txtUserName').fill(credentials.username);await page.locator('[id$="_txtPassword"]').fill(credentials.password);
  await Promise.all([page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame()}),page.locator('[id$="_bLogin"]').click()]);
  await page.goto('https://ontario.order.unilock.com/loggedinwelcome.aspx',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1000);
  const doc=await readPortalDocument(page);
  const calendar=await page.evaluate(()=>{
    const inputs=[...document.querySelectorAll('input[id*="datepicker"]')].map(input=>({id:input.id,value:input.value,name:input.name}));
    const input=document.querySelector('input[id*="datepicker"]'),$=window.jQuery;
    const options={};for(const key of ['minDate','dateFormat','onSelect','onClose','beforeShowDay','defaultDate']) {
      try {const value=$(input).datepicker('option',key);options[key]=typeof value==='function'?value.toString():value;}catch {options[key]='unavailable';}
    }
    return {inputs,options};
  });
  await page.goto('https://ontario.order.unilock.com/shoppingCart.aspx',{waitUntil:'domcontentloaded'});
  const cart=await readPortalDocument(page);
  const cartDates=await page.evaluate(()=>[...document.querySelectorAll('input[id*="datepicker"]')].map(input=>({id:input.id,value:input.value,defaultDate:window.jQuery(input).datepicker('option','defaultDate')})));
  console.log(JSON.stringify({shipping:doc.shipping,selects:doc.selects.filter(row=>/ship|location/iu.test(row.id)),calendar,
    cart:{shipping:cart.shipping,rows:cart.cartRows.map(row=>({sku:row.sku,quantity:row.quantity,uom:row.uom})),dates:cartDates,dateTexts:cart.bodyText.match(/.{0,60}\b\d{1,2}\/\d{1,2}\/\d{4}\b.{0,60}/gu)}}));
} finally {credentials.password=null;await browser.close();await closeDb();}
