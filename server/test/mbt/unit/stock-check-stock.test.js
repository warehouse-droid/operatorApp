import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {stockPortal} from '../../support/stock-check-stock-portal.js';
import {checkUnilockStock} from '../../../src/stock-check/unilock-stock.js';
const secret={username:'fixture-login',password:'fixture-hidden-password'};
async function run(t,options={},callbacks={}) {
  const portal=await stockPortal(options);t.after(()=>portal.close());const steps=[],images=[];
  const product={sku:'177ECS0163703-0',name:'Endura Coping Oat Beige',colour:'OAT BEIGE',pickupLocation:'Pickering',pickupCode:'03',url:portal.baseUrl+'/products/products/endura-coping?child=177ECS0163703-0'};
  const result=await checkUnilockStock({credentials:secret,product,quantity:5,baseUrl:portal.baseUrl,allowTestOrigin:true,
    onStep:async step=>{steps.push(step);await callbacks.onStep?.(step);},
    onScreenshot:async(key,data)=>{images.push(data);return key+'.jpg';},signal:callbacks.signal});
  const writes=portal.actions.filter(row=>row.method==='POST');
  assert.equal(writes.every(row=>['login','location','date','shipment'].includes(row.event)),true,JSON.stringify(writes));
  assert.equal(writes.every(row=>!row.quantity),true,'Stock checks must never submit quantities.');
  return {portal,result,steps,images};
}
test('available product is read before Add, screenshots are saved, and pickup settings are restored',async t=>{
  const {portal,result,steps,images}=await run(t);
  assert.equal(result.status,'stock_available');assert.equal(result.verifiedQuantity,null);assert.equal(result.requestedQuantity,5);
  assert.equal(result.cartAcceptanceVerified,false);assert.equal(result.quantityVerified,false);assert.equal(result.requestDate,'10/15/2026');
  assert.equal(portal.quantity,0);assert.equal(portal.location,'07');assert.equal(portal.date,'10/16/2026');
  for(const key of ['product_page','colour_selection','size_selection','availability_check']) {
    assert.equal(steps.some(row=>row.key===key&&row.status==='success'),true,'Missing step '+key);
  }
  assert.equal(steps.some(row=>row.key==='add_to_cart_skipped'),true);
  assert.equal(steps.some(row=>['quantity_entry','add_to_cart','cart_verification','cart_cleanup'].includes(row.key)),false);
  assert.equal(images.length,2);assert.equal(images.every(data=>data[0]===255&&data[1]===216),true);
  assert.equal(JSON.stringify({steps,result}).includes(secret.password),false);
});
for(const [text,status] of [['Available - Low in Stock','low_stock'],['Production Scheduled for - 2026-10-20','in_production'],
  ['Not available','insufficient_stock'],['Please ask sales','scrape_failure']]) {
  test('pre-cart availability '+text+' reports '+status+' without any cart writes',async t=>{
    const {portal,result,steps}=await run(t,{productAvailability:text});
    assert.equal(result.status,status);assert.equal(result.availabilityText,text);assert.equal(result.verifiedQuantity,null);
    assert.equal(result.acceptedQuantity,null);assert.equal(result.cartAcceptanceVerified,false);assert.equal(portal.quantity,0);
    assert.ok(steps.find(row=>row.key==='availability_check').screenshot);
    if(status==='in_production') {assert.equal(result.eta,'2026-10-20');}
  });
}
test('an existing cart at a different pickup remains intact without switching its pickup',async t=>{
  const {portal,result}=await run(t,{baseline:1});assert.equal(result.status,'scrape_failure');
  assert.equal(portal.quantity,1);assert.equal(portal.location,'07');assert.match(result.reason,/existing cart|pickup/i);
});
test('an existing cart at the same pickup is never incremented, updated or removed',async t=>{
  const {portal,result}=await run(t,{baseline:1,initialLocation:'03'});
  assert.equal(result.status,'stock_available');assert.equal(result.verifiedQuantity,null);assert.equal(portal.quantity,1);
});
test('cancellation after product selection restores settings without touching the cart',async t=>{
  const controller=new AbortController();
  const {portal,result}=await run(t,{}, {signal:controller.signal,onStep:step=>{if(step.key==='product_selection') {controller.abort();}}});
  assert.equal(result.status,'scrape_failure');assert.match(result.reason,/cancelled/);
  assert.equal(portal.quantity,0);assert.equal(portal.location,'07');assert.equal(portal.date,'10/16/2026');
});
test('visible vendor system errors fail with evidence and never attempt Add',async t=>{
  const {portal,result,steps}=await run(t,{pageError:'System error. Please contact customer service.'});
  assert.equal(result.status,'scrape_failure');assert.match(result.reason,/system error/i);assert.equal(portal.quantity,0);
  assert.ok(steps.find(row=>row.status==='failure').screenshot);
});
test('a dangerous Add button is never invoked even when the product is available',async t=>{
  const {portal,result}=await run(t,{checkoutBug:true});assert.equal(result.status,'stock_available');
  assert.equal(portal.actions.some(row=>/checkout|add/i.test(row.event??'')),false);assert.equal(portal.quantity,0);
});
for(const options of [{cartSelects:false},{blankDate:true},{boundCalendar:true},{onCloseSubmit:true},
  {baseline:1,initialLocation:'03',summaryDateOnly:true},{baseline:1,initialLocation:'03',ajaxAdd:true}]) {
  test('native portal settings remain compatible without Add: '+JSON.stringify(options),async t=>{
    const {portal,result}=await run(t,options);assert.equal(result.status,'stock_available');assert.equal(result.verifiedQuantity,null);
    assert.equal(portal.quantity,options.baseline??0);
    if(!options.blankDate) {assert.equal(portal.date,'10/16/2026');}
  });
}
test('an SCM pickup correction keeps the observed plant in the product evidence',async t=>{
  const {portal,result,steps}=await run(t,{selectedPickup:'Chicago'});
  assert.equal(result.status,'stock_available');assert.equal(result.pickupLocation,'Pickering');
  assert.match(steps.find(row=>row.key==='product_selection').detail,/displayed plant Chicago/u);assert.equal(portal.quantity,0);
});
test('a blank bundle label falls back to the visible product availability label',async t=>{
  const {result}=await run(t,{productAvailability:''});assert.equal(result.status,'low_stock');assert.equal(result.availabilitySource,'product_label');
});
test('a fresh empty cart with no location control selects Pickup and restores the unselected shipment method',async t=>{
  const {portal,result}=await run(t,{freshSession:true});assert.equal(result.status,'stock_available');
  assert.equal(portal.quantity,0);assert.equal(portal.shipment,'');assert.equal(portal.location,'');assert.equal(portal.date,'');
});
test('empty-cart shipment and location UpdatePanel postbacks finish without navigating the main frame',async t=>{
  const {portal,result,steps}=await run(t,{freshSession:true,ajaxShipping:true});
  assert.equal(result.status,'stock_available');assert.equal(portal.quantity,0);assert.equal(portal.shipment,'');
  assert.equal(steps.find(step=>step.key==='pickup_date_cleanup').status,'success');
});
test('date selection waits for its full reload after an earlier partial postback response',async t=>{
  const {portal,result}=await run(t,{freshSession:true,ajaxShipping:true,dateAjaxBeforeNav:true});
  assert.equal(result.status,'stock_available');assert.equal(portal.quantity,0);assert.equal(portal.shipment,'');
});
test('transient product GET failures retry twice with diagnostics and never replay a POST',async t=>{
  const {portal,result,steps}=await run(t,{transientGetFailures:2});
  assert.equal(result.status,'stock_available');assert.equal(portal.actions.filter(row=>row.path.startsWith('/products/')&&row.method==='GET').length,3);
  assert.equal(steps.filter(row=>row.key==='portal_read_retry').length,2);assert.equal(portal.actions.filter(row=>row.event==='login').length,1);
});
test('persistent transient GET failures stop after three attempts and forbidden reads do not retry',async t=>{
  for(const options of [{transientGetFailures:5},{forbiddenGet:true}]) {
    const {portal,result}=await run(t,options);assert.equal(result.status,'scrape_failure');
    assert.equal(portal.actions.filter(row=>row.path.startsWith('/products/')&&row.method==='GET').length,options.forbiddenGet?1:3);
    assert.match(result.reason,/HTTP (?:403|503)/u);
  }
});
test('screenshots include availability controls located below the initial viewport',async t=>{
  const {images}=await run(t,{lowerAvailability:true});
  const browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
  const page=await browser.newPage();
  for(const data of images) {
    const pixels=await page.evaluate(async base64=>{
      const img=new Image();img.src='data:image/jpeg;base64,'+base64;await img.decode();
      const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
      const context=canvas.getContext('2d');context.drawImage(img,0,0);
      const values=context.getImageData(0,0,img.width,img.height).data;let count=0;
      for(let i=0;i<values.length;i+=4) {if(values[i]<40&&values[i+1]>140&&values[i+2]>120) {count++;}}
      return count;
    },data.toString('base64'));
    assert.ok(pixels>1000,'The lower availability control must be visible in the saved screenshot.');
  }
});
