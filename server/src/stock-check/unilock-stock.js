import {chromium} from 'playwright';
import {allowedPortalUrl,UNILOCK_ORIGIN,StockCheckError,productAvailabilityVerdict,sanitizeFailure,validateQuantity} from './domain.js';
import {readPortalDocument,selectedProductFromDocument} from './unilock-dom.js';

const control=suffix=>'[id$="_'+suffix+'"]';
function ensureActive(state) {
  if(state.signal?.aborted && !state.cleaning) {throw new StockCheckError('The stock check was cancelled.',409,'STOCK_CHECK_CANCELLED');}
}
async function nativeAction(state,action,{partial=false}={}) {
  ensureActive(state);
  const navigation=state.page.waitForEvent('framenavigated',{predicate:frame=>frame===state.page.mainFrame(),timeout:20000});
  const completion=partial?Promise.any([navigation,state.page.waitForResponse(response=>{
    const request=response.request();
    return request.method()==='POST' && !request.isNavigationRequest() &&
      response.url().startsWith(new URL(state.baseUrl).origin+'/') && request.frame()===state.page.mainFrame();
  },{timeout:20000}).then(response=>response.finished())]):navigation;
  await Promise.all([completion,action()]);
  await state.page.waitForLoadState('domcontentloaded');
  await state.page.waitForFunction(()=>!window.Sys?.WebForms?.PageRequestManager?.getInstance()?.get_isInAsyncPostBack());
  allowedPortalUrl(state.page.url(),state.originOptions);
}
async function visit(state,url) {
  const target=allowedPortalUrl(url,state.originOptions).href;
  for(let attempt=0;attempt<3;attempt++) {
    ensureActive(state);
    try {
      const response=await state.page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
      allowedPortalUrl(state.page.url(),state.originOptions);
      const status=response?.status()??0;
      if(status>=400) {const error=new StockCheckError('The vendor portal returned HTTP '+status+'.');error.retryable=[429,502,503,504].includes(status);throw error;}
      return await readPortalDocument(state.page);
    } catch(error) {
      const transient=error.retryable || /Timeout|net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|EMPTY_RESPONSE)/u.test(error.message);
      if(attempt===2 || !transient || state.signal?.aborted) {throw error;}
      await step(state,'portal_read_retry','info','Retry '+(attempt+1)+'/2 for a transient read failure: '+sanitizeFailure(error,[state.credentials.password]));
      await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
    }
  }
}
async function step(state,key,status,detail,capture=false) {
  let screenshot=null;
  if(capture) {
    await state.page.locator('input[type=password]').evaluateAll(nodes=>nodes.forEach(node=>{node.value='';}));
    if(state.availabilityId && ['product_selection','availability_check'].includes(key)) {
      await state.page.locator('[id="'+state.availabilityId+'"]').evaluate(node=>node.scrollIntoView({block:'center',inline:'nearest'}));
    }
    const data=await state.page.screenshot({type:'jpeg',quality:80,fullPage:false,timeout:15000});
    screenshot=await state.onScreenshot(key,data);
  }
  await state.onStep({key,status,detail:sanitizeFailure(detail,[state.credentials.password]),screenshot});
}
async function login(state) {
  state.currentStep='login';
  await visit(state,'/login.aspx');
  await state.page.locator('#txtUserName,'+control('txtUserName')).first().fill(state.credentials.username);
  await state.page.locator(control('txtPassword')).fill(state.credentials.password);
  await nativeAction(state,()=>state.page.locator(control('bLogin')).click());
  const logged=await state.page.locator('a[href*="logout" i]').count();
  if(!logged || /login\.aspx/iu.test(state.page.url())) {throw new StockCheckError('The vendor did not accept this login.',422,'STOCK_CHECK_LOGIN_FAILED');}
  await step(state,'login','success','Vendor login succeeded.');
}
function selectedShipping(doc) {
  const shipment=doc.selects.find(row=>row.id.endsWith('_dpshipment'))?.value,
    location=doc.selects.find(row=>row.id.endsWith('_dplocations'))?.value;
  return {shipment,location:shipment===''?(location??''):location};
}
function savedRequestDate(doc) {
  return /Requested\s*By\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})/iu.exec(doc.bodyText??'')?.[1] || /\b\d{1,2}\/\d{1,2}\/\d{4}\b/u.exec(doc.shipping)?.[0] || null;
}
async function dateSelection(state,{restore=null}={}) {
  const choice=await state.page.evaluate(({restoreDate})=>{
    const input=document.querySelector('input[id$="_datepicker"]'),$=window.jQuery;
    if(!input || !$ || !$.datepicker) {throw new Error('The native request-date picker is unavailable.');}
    const picker=$(input),format=picker.datepicker('option','dateFormat')||'mm/dd/yy';
    let chosen;
    if(restoreDate) {
      const parts=restoreDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u);
      if(!parts) {throw new Error('The original request date could not be restored.');}
      chosen=new Date(Number(parts[3]),Number(parts[1])-1,Number(parts[2]));
    } else {
      let minimum=picker.datepicker('option','minDate');
      if(typeof minimum==='number') {const today=new Date();today.setHours(0,0,0,0);today.setDate(today.getDate()+minimum);minimum=today;}
      if(typeof minimum==='string') {minimum=$.datepicker.parseDate(format,minimum);}
      if(!(minimum instanceof Date) || !Number.isFinite(minimum.getTime())) {throw new Error('The vendor did not supply an earliest request date.');}
      const allowed=picker.datepicker('option','beforeShowDay');
      for(let offset=0;offset<180;offset++) {
        const date=new Date(minimum);date.setDate(date.getDate()+offset);
        if(!allowed || allowed.call(input,date)[0]) {chosen=date;break;}
      }
      if(!chosen) {throw new Error('No enabled request date was returned by the vendor.');}
    }
    const value=$.datepicker.formatDate(format,chosen),handler=picker.datepicker('option','onSelect');
    if(typeof handler!=='function') {throw new Error('The native request-date selection action is unavailable.');}
    return {value,year:chosen.getFullYear(),month:chosen.getMonth(),day:chosen.getDate()};
  },{restoreDate:restore});
  await state.page.evaluate(choice=>{
    const input=document.querySelector('input[id$="_datepicker"]'),$=window.jQuery,picker=$(input);
    picker.datepicker('setDate',new Date(choice.year,choice.month,choice.day));
  },choice);
  await state.page.locator('input[id$="_datepicker"]').click();
  const day=state.page.locator('.ui-datepicker-calendar td[data-year="'+choice.year+'"][data-month="'+choice.month+'"] a')
    .filter({hasText:new RegExp('^'+choice.day+'$','u')});
  await nativeAction(state,()=>day.click());
  return choice.value;
}
async function originalRequestDate(state,doc) {
  return (await state.page.locator('input[id$="_datepicker"]').inputValue()) || savedRequestDate(doc);
}
async function snapshot(state) {
  state.currentStep='cart_baseline';
  const doc=await visit(state,'/loggedinwelcome.aspx');
  const date=await originalRequestDate(state,doc);
  state.original={...selectedShipping(doc),date};
  if(typeof state.original.shipment!=='string' || typeof state.original.location!=='string') {throw new StockCheckError('The original pickup settings could not be recorded.');}
  const cart=await visit(state,'/shoppingCart.aspx');
  state.original.date??=savedRequestDate(cart);
  if(cart.cartParseFailures) {throw new StockCheckError('A pre-existing cart line could not be read. SCM review is required.');}
  state.baseline=cart.cartRows;
  if(cart.cartRows.length && !state.original.date) {throw new StockCheckError('The existing cart has no readable original request date. SCM review is required before testing.');}
  const existing=cart.cartRows.filter(row=>row.sku===state.product.sku);
  if(existing.length>1) {throw new StockCheckError('The cart contains duplicate lines for this SKU. SCM review is required.');}
  state.baselineQuantity=existing[0]?.quantity??0;
  await state.onBaseline({original:state.original,cartRows:state.baseline.map(row=>({sku:row.sku,quantity:row.quantity,uom:row.uom}))});
  if(existing.length && existing[0].uom!=='BNDL') {throw new StockCheckError('The existing cart SKU uses a different unit. SCM must review the cart before this check.');}
  if(cart.cartRows.length && (state.original.location!==state.product.pickupCode || state.original.shipment!=='PICKUP|PickUp')) {
    throw new StockCheckError('The existing cart uses a different pickup point. SCM must review the cart before this check.');
  }
  await step(state,'cart_baseline','success','Recorded '+cart.cartRows.length+' existing cart lines.');
}
async function configurePickup(state) {
  state.currentStep='shipment_method';
  await visit(state,'/loggedinwelcome.aspx');state.settingsTouched=true;
  const shipment=state.page.locator(control('dpshipment'));
  if(await shipment.inputValue()!=='PICKUP|PickUp') {await nativeAction(state,()=>shipment.selectOption('PICKUP|PickUp'),{partial:true});}
  await step(state,'shipment_method','success','Selected Pickup.');
  state.currentStep='pickup_location';
  const location=state.page.locator(control('dplocations'));
  if(await location.inputValue()!==state.product.pickupCode) {await nativeAction(state,()=>location.selectOption(state.product.pickupCode),{partial:true});}
  const doc=await readPortalDocument(state.page);
  if(selectedShipping(doc).location!==state.product.pickupCode) {throw new StockCheckError('The vendor did not retain the product pickup point.');}
  await step(state,'pickup_location','success','Selected '+state.product.pickupLocation+'.');
  state.currentStep='request_date';
  state.requestDate=await dateSelection(state);
  await step(state,'request_date','success','Selected earliest enabled request date: '+state.requestDate+'.');
}
async function selectProduct(state) {
  state.currentStep='product_page';
  let doc=await visit(state,state.product.url);
  await step(state,'product_page','success','Opened the saved exact vendor product page.');
  state.currentStep='colour_selection';
  // A child URL is the portal's exact saved colour/size selection, and is verified again below.
  if(doc.selected?.sku!==state.product.sku) {
    const colour=doc.colours.find(row=>row.title.toUpperCase().startsWith(state.product.colour.toUpperCase()+','));
    if(!colour) {throw new StockCheckError('The requested colour control could not be found.');}
    await nativeAction(state,()=>state.page.locator('[id="'+colour.id+'"]').click());doc=await readPortalDocument(state.page);
    const child=doc.children.find(row=>row.sku===state.product.sku);
    if(!child) {throw new StockCheckError('The exact requested size/SKU could not be found under this colour.');}
    await nativeAction(state,()=>state.page.locator('[id="'+child.id+'"]').click());doc=await readPortalDocument(state.page);
  }
  const selected=selectedProductFromDocument(doc,{productUrl:state.product.url,expectedSku:state.product.sku,...state.originOptions,allowUnmappedPickup:true});
  // SCM's pickup correction is intentionally authoritative; source drift is still visible in the evidence.
  if(state.product.colour && selected.colour.toUpperCase()!==state.product.colour.toUpperCase()) {throw new StockCheckError('The portal colour does not match the selected catalog product.');}
  await step(state,'colour_selection','success','Verified selected colour: '+selected.colour+'.');
  await step(state,'size_selection','success','Verified exact size/SKU: '+selected.size+' / '+selected.sku+'.');
  if(doc.errors.length) {throw new StockCheckError(sanitizeFailure(doc.errors.join(' '),[state.credentials.password]));}
  state.availabilityId=doc.productAvailabilityId;
  state.productAvailability=sanitizeFailure(doc.productBundleAvailability,[state.credentials.password]);
  state.productAvailabilitySource=doc.productAvailabilitySource;
  await step(state,'product_selection','success',selected.name+' / '+selected.sku+' / displayed plant '+selected.pickupLocation+'.',true);
}
async function checkProductAvailability(state) {
  ensureActive(state);
  state.currentStep='availability_check';
  const result=productAvailabilityVerdict({availabilityText:state.productAvailability,
    availabilitySource:state.productAvailabilitySource,requestedQuantity:state.quantity});
  const status=result.status==='stock_available'?'success':result.status==='scrape_failure'?'failure':'info';
  await step(state,'availability_check',status,result.reason,true);
  await step(state,'add_to_cart_skipped','info','Availability was read before Add to Cart. No quantity was entered or added.');
  return {...result,requestDate:state.requestDate,pickupLocation:state.product.pickupLocation,sku:state.product.sku,requestedQuantity:state.quantity};
}
function validatePortalRequest(state,request) {
  if(request.isNavigationRequest() || request.method()!=='GET') {allowedPortalUrl(request.url(),state.originOptions);}
  if(request.method()==='POST') {
    const fields=new URLSearchParams(request.postData()??''),target=fields.get('__EVENTTARGET')??'';
    if(/add.?to.?cart|ibAdd|removefromcart|butUpdatCart/iu.test(target) ||
      [...fields.keys()].some(key=>/ibAddToCart(?:\.[xy])?$/iu.test(key))) {
      throw new StockCheckError('Cart changes are disabled during stock checks.');
    }
    if(/checkout|place.?order|submit.?order|finali[sz]e|payment/iu.test(target)) {
      throw new StockCheckError('The vendor tried to open checkout during a stock check. The request was blocked; SCM review is required.');
    }
  }
}
async function restoreSettings(state) {
  await visit(state,'/loggedinwelcome.aspx');
  if(state.original.shipment!=='') {
    const location=state.page.locator(control('dplocations'));
    if(await location.inputValue()!==state.original.location) {await nativeAction(state,()=>location.selectOption(state.original.location),{partial:true});}
  }
  const shipment=state.page.locator(control('dpshipment'));
  if(await shipment.inputValue()!==state.original.shipment) {await nativeAction(state,()=>shipment.selectOption(state.original.shipment),{partial:true});}
  if(state.original.date) {await restoreOriginalDate(state);}
  const doc=await readPortalDocument(state.page),current=selectedShipping(doc);
  const cart=await visit(state,'/shoppingCart.aspx');
  if((current.location??'')!==state.original.location || (current.shipment??'')!==state.original.shipment || (state.original.date && savedRequestDate(cart)!==state.original.date)) {
    throw new StockCheckError('The original shipment settings could not be verified after cleanup.');
  }
  await step(state,'pickup_date_cleanup','success',state.original.date?'Restored the original shipment method, pickup point and request date.':
    'Restored prior pickup settings. No request date was selected before this empty-cart session; the isolated session is closing.');
}
async function restoreOriginalDate(state) {
  // Restoration is limited to the exact pre-existing saved date, including one
  // older than today's minimum for a new request. Invoke both native callbacks.
  await nativeAction(state,()=>state.page.evaluate(date=>{
    const input=document.querySelector('input[id$="_datepicker"]'),$=window.jQuery,picker=$(input),inst=$.datepicker._getInst(input);
    input.value=date;
    const select=picker.datepicker('option','onSelect'),close=picker.datepicker('option','onClose');
    if(typeof select!=='function') {throw new Error('The native date restoration action is unavailable.');}
    select.call(input,date,inst);if(typeof close==='function') {close.call(input,date,inst);}
  },state.original.date));
}
async function runCheck(options,loginOnly) {
  const state={baseUrl:UNILOCK_ORIGIN,onStep:async()=>{},onScreenshot:async()=>null,onBaseline:async()=>{},...options,dialogs:[]};
  state.originOptions={baseUrl:state.baseUrl,allowTestOrigin:Boolean(state.allowTestOrigin)};
  allowedPortalUrl('/login.aspx',state.originOptions);
  if(!loginOnly) {state.quantity=validateQuantity(state.quantity);}
  const browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage'],...state.launchOptions});
  let result;
  try {
    const context=await browser.newContext({viewport:{width:1280,height:900}});state.page=await context.newPage();state.page.setDefaultTimeout(20000);
    state.page.on('dialog',async dialog=>{state.dialogs.push(dialog.message());if(state.cleaning && dialog.type()==='confirm') {await dialog.accept();}else {await dialog.dismiss();}});
    await context.route('**/*',async route=>{
      const request=route.request();
      try {validatePortalRequest(state,request);await route.continue();}
      catch(error) {state.blockedReason=error.message;await route.abort();}
    });
    await login(state);
    if(loginOnly) {await step(state,'login_verification','success','Authenticated vendor welcome page verified.',true);return {status:'login_verified',reason:'Vendor login succeeded.'};}
    await snapshot(state);await configurePickup(state);await selectProduct(state);
    result=await checkProductAvailability(state);
  } catch(error) {
    result={status:'scrape_failure',reason:state.blockedReason??sanitizeFailure(error,[state.credentials.password])};
    await step(state,state.currentStep??'check_failure','failure',result.reason,Boolean(state.page && !state.page.isClosed())).catch(()=>{});
  } finally {
    state.cleaning=true;
    try {if(state.settingsTouched) {await restoreSettings(state);}}
    catch(error) {result={status:'scrape_failure',reason:'Cleanup failed: '+sanitizeFailure(error,[state.credentials.password]),requiresScmReview:true};
      await step(state,'cleanup','failure',result.reason).catch(()=>{});}
    await browser.close();
  }
  return result;
}
export async function checkUnilockStock(options) {return runCheck(options,false);}
export async function verifyUnilockLogin(options) {return runCheck(options,true);}
