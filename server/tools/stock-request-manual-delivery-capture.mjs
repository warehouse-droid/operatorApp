import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out='/app/manual-out',captures=[],errors=[];
await mkdir(out+'/screenshots',{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const yards=[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'2967'},{locationId:15,yardCode:'12441'},{locationId:26,yardCode:'150'}];
const trainingDate='2026-09-30T14:00:00Z';
const item={itemId:4757,itemCode:'PAVER-60-CHARCOAL',itemName:'PAVER-60-CHARCOAL',displayName:'Paver 60 mm — Charcoal',description:'Concrete paver, charcoal • 100 SQFT per pallet',salesUom:'SQFT',toPlt:100,toLyr:10,toPcs:null,toSec:null,vendor:'Example Stone Supply'};
const extra={...item,itemId:4758,itemCode:'WALL-CAP-GREY',itemName:'WALL-CAP-GREY',displayName:'Wall cap — Grey',description:'Wall cap, grey • 40 PC per pallet',salesUom:'PC',toPlt:40,toLyr:10,toPcs:1};
const availability=(material=item)=>({item:material,yards:yards.map(yard=>({...yard,onHand:1000,liveAvailable:yard.locationId===28?0:1000,activeReserved:0,requestableAvailable:yard.locationId===28?0:1000,syncedAt:trainingDate}))});
function regular({stocking=false,method='pickup',approved=false,expired=false,quantity=200,source=1}={}){
 const evidence={lineId:101,itemId:item.itemId,sourceLocationId:source,requestedQuantity:quantity,groupedRequestedQuantity:quantity,availableQuantity:1000,safetyQuantity:800,remainingQuantity:1000-quantity,shortfallQuantity:Math.max(0,quantity-200),unit:'SQFT',stockEligible:quantity<=200,reasons:[...(stocking?['stocking_scm_review']:[]),...(quantity>200?['below_safety']:[])]};
 return {id:501,requestRef:'STREQ-000201',workflowVersion:2,requestType:'regular',requestedBy:'training-sales',requestedByName:'Jordan Lee',destinationLocationId:28,destinationName:'2967',status:approved?'active':'submitted',bucket:approved?'accepted':'pending',revision:3,manualDecisionEventId:0,createdAt:trainingDate,updatedAt:trainingDate,firstScmDecisionAt:approved?trainingDate:null,remarks:'Training example — customer needs these items at yard 2967.',
 regular:{customerName:'Example Landscaping',deliveryMethod:stocking?'stocking':method,arrivalDate:!stocking&&method==='delivery'?'2026-10-06':null,arrivalTime:!stocking&&method==='delivery'?'15:00':null,arrivalAt:!stocking&&method==='delivery'?'2026-10-06T19:00:00Z':null,timeZone:'America/Toronto',approval:{automatic:approved&&!stocking,autoApprovalEnabled:true,deliveryMethod:stocking?'stocking':method,leadHours:12,leadTimeApplies:!stocking&&method==='delivery',enoughTime:true,evaluatedAt:trainingDate,lines:[evidence]},approvalValidityMinutes:15,approvalExpiresAt:approved?(expired?'2026-09-29T12:15:00Z':new Date(Date.now()+15*60000).toISOString()):null},
 lines:[{id:101,itemId:item.itemId,itemName:item.itemCode,itemDescription:item.description,sourceLocationId:source,sourceName:yards.find(x=>x.locationId===source).yardCode,destinationLocationId:28,destinationName:'2967',salesQty:quantity,salesUom:'SQFT',quantityMode:'conversion',pallets:quantity/100,layers:0,pieces:null,sections:null,toPlt:100,toLyr:10,toPcs:null,toSec:null,status:approved?'approved':'submitted',decision:approved?'stock':null,approvalEvidence:evidence}],transfers:[],availability:[availability()],events:[]};
}
function special({accepted=false,so=false,po=false,method='yard_pickup',stage,waiting=false}={}){
 const lines=[{id:201,productName:'Architectural slab',color:'Charcoal',size:'24 × 24 in',detailSpec:'Smooth finish; matching batch',quantity:2,uom:'PLT',originalRate:520,rate:520,rateUom:'PLT',pricingSource:'enquiry',discountPercent:5,packageQuantity:2,conversionToPc:20,subtotal:988,requiredDate:'2026-10-06',palletQty:2,layerQty:0,sectionQty:0,pieceQty:40,customerNote:'Keep both pallets from the same batch.',salesDecision:accepted?'accepted':'pending',supplyStatus:waiting?'production':'in_stock',availabilityMode:waiting?'dated':'ready',availableDate:waiting?'2026-10-08':null,vendorYard:'Example Stone — 100 Training Road, Toronto',responseVendorId:9001,responseVendorName:'Example Stone Supply',salesVisibleNote:waiting?'Production is expected to finish on 8 October.':'Vendor confirms 2 pallets are available.',scmInternalNote:'Vendor contacted by SCM.',itemResolution:accepted?{itemId:2055,itemName:'MBBS-Special',description:'Architectural slab | Charcoal | 24 × 24 in | Smooth finish; matching batch',salesQuantity:40,salesUom:'PC',purchaseQuantity:40,purchaseUom:'PC'}:null}];
 const material={caseLineId:201,itemId:2055,description:'Architectural slab | Charcoal | 24 × 24 in | Smooth finish; matching batch',quantity:40,uom:'PC',rate:26,unitPurchaseCost:18,packageQuantity:2,packageUom:'PLT',conversionToPc:20,originalRate:520,discountPercent:5,pricingSource:'enquiry'};
 return {id:601,requestRef:'SPREQ-000301',revision:4,stage:stage||(po?(waiting?'wait_for_production':method==='vendor_pickup'?'confirmed':'dispatch_arrangement'):so?'confirmed':accepted?'await_customer_confirmation':'new_enquiry'),customerId:8001,customerName:'Example Landscaping',customerPhone:'416-555-0142',vendorId:9001,vendorName:'Example Stone Supply',requestedBy:'training-sales',requestedByName:'Jordan Lee',netsuiteSalesRepId:123,netsuiteSalesRepName:'Jordan Lee',netsuiteCustomerName:accepted?'Example Landscaping — Trade Account':null,netsuiteCustomerId:accepted?8002:null,storeLocationId:28,storeName:'2967',inquiryDate:'2026-09-29',expiresOn:'2026-10-29',createdAt:trainingDate,updatedAt:trainingDate,fulfillmentMethod:method,operationalYardLocationId:28,deliveryAddress:method==='mbt_delivery'?'123 Training Avenue, Toronto ON':'',deliveryContactName:'Alex Chen',deliveryContactPhone:'416-555-0142',deliveryDate:'2026-10-06',windowStart:'09:00',windowEnd:'12:00',deliveryInstructions:'Use the wide driveway. Call before arrival.',palletTotal:2,palletRate:35,closeStatus:'active',salesOrderId:so?7001:null,salesOrderRef:so?'SOB-DEMO-301':null,salesOrderApproved:so,salesOrderStatus:so?'Pending Fulfillment':null,salesOrderSkipped:false,purchaseOrderId:po?7002:null,purchaseOrderRef:po?'POB-DEMO-301':null,purchaseOrderApproved:po,purchaseOrderStatus:po?'Pending Receipt':null,purchaseOrderSkipped:false,salesOrderLines:accepted?[{...material}]:[],purchaseOrderLines:accepted?[{...material}]:[],lines,media:[],events:[],readinessAlerts:[],remarks:'Training example — special finish requested by customer.',dispatchPlanning:{anyPlanned:false,salesOrder:{planned:false,plans:[]},purchaseOrder:{planned:false,plans:[]}}};
}
async function screen({role='sales',type='regular',record,records,preview,alert=false}){
 const context=await browser.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:1,serviceWorkers:'block'});
 await context.addInitScript(()=>{
  localStorage.setItem('mbbs.staff.token','training-session');localStorage.setItem('mbbs.scm.stockRequests.queue','request');
  window.EventSource=class{addEventListener(){}close(){}};
 });
 const page=await context.newPage();page.setDefaultTimeout(8000);
 page.on('pageerror',error=>errors.push(error.message));
 const current=structuredClone(record|| (type==='regular'?regular():special()));
 const state={current,requests:records||[current],preview,posts:[]};
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(url.hostname!=='localhost')return route.abort();
  if(path.startsWith('/api/')){
   let value={requests:[],yards:[],total:0};
   if(path.endsWith('/delivery/operations/active'))value={operation:null};
   else if(path.endsWith('/delivery/operations')&&request.method()==='POST'){
    const command=request.postDataJSON();state.operation={id:command.operationId,status:'running',phase:'checking_so'};value=state.operation;
   }
   else if(path.includes('/delivery/operations/'))value=state.busy?state.operation:state.failure?
    {...state.operation,status:'failed',error:'Request failed (524)',code:'TRAINING_FAILURE'}:
    {...state.operation,status:'succeeded',result:state.preview};
   else if(path==='/api/auth/me')value={operator:{id:'training-'+role,username:role==='sales'?'jordan.lee':'scm.team',display_name:role==='sales'?'Jordan Lee':'SCM Team',role,roles:[role],yard_location_ids:[28],yardLocationIds:[28]}};
   else if(path.endsWith('/sales-reps'))value={salesReps:[{id:123,name:'Jordan Lee'}]};
   else if(path.endsWith('/customers'))value={customers:[{id:8001,entityNumber:'C-DEMO-01',displayName:'Example Landscaping',phone:'416-555-0142'},{id:8002,entityNumber:'C-DEMO-02',displayName:'Example Landscaping — Trade Account',phone:'416-555-0142'}]};
   else if(path.endsWith('/vendors'))value={vendors:[{id:9001,name:'Example Stone Supply'}]};
   else if(path.endsWith('/policy'))value={enabled:true,testSkipOrdersEnabled:true};
   else if(path==='/api/scm/smart/bootstrap')value={settings:{regularStockAutoApprovalEnabled:true,regularStockLeadHours:12,regularStockApprovalMinutes:15,timeZone:'America/Toronto'},planningRuns:[],latestRun:{id:801,revision:1,status:'ready',proposals:[],regularReplenishments:[{id:901,revision:1,itemName:item.itemCode,sourceLocationId:1,quantity:300,unit:'SQFT',proposalStatus:'Awaiting PO review',requests:[{requestRef:'STREQ-000201',salesOrderRef:'SOB-DEMO-201'}],evidence:{}}]}};
   else if(path.endsWith('/special-stock-requests/alerts'))value=role==='sales'?{awaitCustomerConfirmation:1,dispatchArrangement:0,waitForProduction:1,total:alert?2:0}:{newRequests:1,confirmedOrders:1,total:alert?2:0};
   else if(path.endsWith('/stock-requests/alerts'))value=role==='scm'?{manualReview:1,total:alert?1:0}:{unread:1,total:alert?1:0,requests:alert?[{id:501,requestRef:'STREQ-000201',eventId:1}]:[]};
   else if(path.includes('/stock-request-items'))value=path.endsWith('/availability/refresh')?availability(path.includes('4758')?extra:item):{items:url.searchParams.get('search')?.toUpperCase().includes('WALL')?[extra]:[item,extra]};
   else if(path.endsWith('/pickup-preview')||path.endsWith('/sales-order/preview')){if(state.previewDelay)await new Promise(resolve=>setTimeout(resolve,state.previewDelay));value=state.preview;}
   else if(path.endsWith('/special-stock-requests'))value={requests:state.requests,yards:role==='sales'?[yards[1]]:yards,vendors:['Example Stone Supply','Example Masonry'],total:state.requests.length};
   else if(path.endsWith('/stock-requests'))value={requests:state.requests,yards:[yards[1]],availabilityPolicy:{allowOverAvailability:true,revision:1},filterOptions:{vendors:['Example Stone Supply'],sourceYards:yards,destinationYards:yards}};
   else if(/\/(?:special-stock-requests|stock-requests)\/\d+/.test(path))value=state.current;
   if(['POST','PUT','PATCH','DELETE'].includes(request.method()))state.posts.push({path,method:request.method(),body:request.postDataJSON()});
   return route.fulfill({json:value});
  }
  const file=({'/sales/stock-requests':'/sales-stock-requests.html','/scm/stock-requests':'/scm-stock-requests.html','/scm/smart':'/scm-smart.html'})[path]||path;
  try{return route.fulfill({body:await readFile('/app/public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html',svg:'image/svg+xml',png:'image/png'})[file.split('.').pop()]||'application/octet-stream'});}
  catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(type==='smart'?'http://localhost/scm/smart':`http://localhost/${role}/stock-requests?tab=${type}`);
 if(type==='smart'){await page.locator('[data-smart-tab="settings"]').waitFor();return {page,context,state};}
 await page.locator(type==='special'?`[data-special-${role==='sales'?'sales':'scm'}-action="select"]`:role==='sales'?'[data-sales-stock-action="select"]':'[data-scm-stock-action="select"]').first().click();
 await page.locator('.stock-request-detail h2').first().waitFor();
 return {page,context,state};
}
async function capture(page,name,selector=null,caption=''){
 if(selector){await page.setViewportSize({width:1440,height:3200});await page.locator('.stock-request-detail').evaluateAll(elements=>elements.forEach(element=>element.scrollTop=0));}
 const target=selector?page.locator(selector).first():page;
 await page.evaluate(()=>document.fonts.ready);
 if(selector&&selector.endsWith('.stock-request-detail')){
  const clip=await target.evaluate(el=>{const r=el.getBoundingClientRect();const bottom=Math.max(...[...el.children].filter(c=>c.getBoundingClientRect().height).map(c=>c.getBoundingClientRect().bottom));return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,bottom-r.y+16)};});
  await page.screenshot({path:`${out}/screenshots/${name}.png`,clip});
 }else await target.screenshot({path:`${out}/screenshots/${name}.png`,...(selector?{}:{fullPage:false})});
 captures.push({name,filename:`screenshots/${name}.png`,caption});
 console.log(name);
}
async function captureSpan(page,name,startSelector,endSelector,caption){
 await page.setViewportSize({width:1440,height:3200});await page.locator('.stock-request-detail').evaluateAll(elements=>elements.forEach(element=>element.scrollTop=0));
 const start=await page.locator(startSelector).first().boundingBox(),end=await page.locator(endSelector).last().boundingBox();
 const clip={x:Math.min(start.x,end.x),y:start.y,width:Math.max(start.x+start.width,end.x+end.width)-Math.min(start.x,end.x),height:end.y+end.height-start.y};
 await page.screenshot({path:`${out}/screenshots/${name}.png`,clip});captures.push({name,filename:`screenshots/${name}.png`,caption});console.log(name);
}
async function use(options,work){const view=await screen(options);try{await work(view);}catch(error){await view.page.screenshot({path:out+'/capture-failure.png',fullPage:true});await writeFile(out+'/capture-failure.txt',await view.page.locator('body').innerText());throw error;}finally{await view.context.close();}}

function delivery({source=1,complete=false}={}){
 const result=regular({approved:complete,source});
 result.regular={deliveryVersion:1,deliveryMethod:'delivery',sourceLocationId:source,sourceName:yards.find(y=>y.locationId===source).yardCode,
  salesOrderRef:'SOB-DEMO-202',palletQuantity:2,deliveryApproval:complete?'approved':'pending',approval:{automatic:source===1},handoffStatus:complete?'complete':'pending'};
 if(complete)result.transfers=[{id:41,transferRef:'STTO-DEMO-202',netsuiteTransferOrderRef:'TOB-DEMO-202',sourceName:'3445',destinationName:'2967',
  confirmationStatus:'complete',printJobId:91,printStatus:'queued',lines:result.lines,status:'pending_fulfillment'}];
 return result;
}
try{
 await use({record:regular()},async({page,state})=>{
  await page.locator('[data-sales-stock-action="new"]').click();
  await page.locator('[data-regular-field="deliveryMethod"]').selectOption('delivery');
  await page.locator('[data-regular-field="sourceLocationId"]').selectOption('1');
  state.preview={baseLocationId:28,baseName:'2967',salesOrderRef:'SOB-DEMO-202',palletQuantity:2,
   lines:[{itemName:item.itemName,salesQty:200,salesUom:'SQFT',quantityBasis:'whole_line'}]};
  state.busy=true;
  await page.locator('[data-regular-field="salesOrderRef"]').fill('SOB-DEMO-202');
  await page.locator('[data-regular-field="salesOrderRef"]').blur();
  await page.locator('#regularStockDialogMessage').filter({hasText:'Checking SO quantities'}).waitFor();
  assert.equal(await page.locator('button:enabled').count(),0);
  await capture(page,'30-delivery-busy','dialog.regular-stock-dialog','Checking SO quantity and Base Yard; controls are disabled');
  state.busy=false;
  await page.locator('[data-delivery-calculation]').filter({hasText:'PALLET: 2'}).waitFor();
  await capture(page,'30-delivery-form','[data-sales-stock-form]','Delivery with Base Yard 2967, Target Yard 3445 and calculated 200 SQFT / 2 PALLET');
  state.failure=true;
  await page.locator('[data-regular-field="salesOrderRef"]').fill('SOB-DEMO-203');
  await page.locator('[data-regular-field="salesOrderRef"]').blur();
  await page.locator('[data-sales-stock-action="delivery-preview-retry"]').waitFor();
  await capture(page,'30-delivery-retry','[data-delivery-calculation]','Retry SO check after a failed read without changing the input');
 });
 await use({role:'scm',record:delivery({source:26}),alert:true},async({page})=>{
  await page.locator('[data-scm-stock-action="approve-stock"]').waitFor();
  await capture(page,'30-delivery-scm','section.stock-request-detail','SCM approves or rejects the entire Delivery request for Target Yard 150');
 });
 await use({record:delivery({complete:true})},async({page})=>{
  await captureSpan(page,'30-delivery-result','.regular-delivery-summary','.regular-delivery-result','Saved TO route and print queue status');
 });
 await use({record:regular()},async({page})=>{
  await page.locator('[data-sales-stock-action="new"]').click();
  await page.locator('[data-regular-field="deliveryMethod"]').selectOption('pickup');
  await page.locator('[data-regular-field="customerName"]').fill('Example Landscaping');
  await page.locator('[data-sales-stock-field="itemSearch"]').fill('PAVER');
  await page.locator('[data-sales-stock-action="choose-item"]').first().click();
  await page.locator('[data-sales-stock-field="sourceLocationId"]').selectOption('1');
  await page.locator('[data-sales-stock-field="pallets"]').fill('2');
  await capture(page,'02-regular-form','[data-sales-stock-form]','Pickup request: 200 SQFT requested from 3445 for Sales yard 2967');
 });
 await use({role:'scm',record:regular({quantity:201}),alert:true},async({page})=>{
  await capture(page,'03-regular-scm','section.stock-request-detail','Pickup SCM review: remaining stock below safety');
 });
 await use({record:regular({approved:true,expired:true})},async({page})=>{
  await capture(page,'07-regular-expired','.regular-stock-expired','Expired Pickup approval can be re-raised');
 });
 assert.deepEqual(errors,[]);
 await writeFile(out+'/delivery-screenshots.json',JSON.stringify({captures,errors,source:'Deployed 2026-09-30 UI; fictional training data; no live API calls or order writes'},null,2)+'\n');
 console.log(JSON.stringify({screenshots:captures.length,errors}));
}finally{await browser.close();}
