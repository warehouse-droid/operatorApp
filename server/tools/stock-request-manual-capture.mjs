import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out='/app/manual-out',captures=[],errors=[];
await mkdir(out+'/screenshots',{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const yards=[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'2967'},{locationId:15,yardCode:'12441'},{locationId:26,yardCode:'150'}];
const trainingDate='2026-09-29T14:00:00Z';
const item={itemId:4757,itemCode:'PAVER-60-CHARCOAL',itemName:'PAVER-60-CHARCOAL',displayName:'Paver 60 mm — Charcoal',description:'Concrete paver, charcoal • 100 SQFT per pallet',salesUom:'SQFT',toPlt:100,toLyr:10,toPcs:null,toSec:null,vendor:'Example Stone Supply'};
const extra={...item,itemId:4758,itemCode:'WALL-CAP-GREY',itemName:'WALL-CAP-GREY',displayName:'Wall cap — Grey',description:'Wall cap, grey • 40 PC per pallet',salesUom:'PC',toPlt:40,toLyr:10,toPcs:1};
const availability=(material=item)=>({item:material,yards:yards.map(yard=>({...yard,onHand:1000,liveAvailable:yard.locationId===28?0:1000,activeReserved:0,requestableAvailable:yard.locationId===28?0:1000,syncedAt:trainingDate}))});
function regular({stocking=false,method='delivery',approved=false,expired=false,quantity=200,source=1}={}){
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
   if(path==='/api/auth/me')value={operator:{id:'training-'+role,username:role==='sales'?'jordan.lee':'scm.team',display_name:role==='sales'?'Jordan Lee':'SCM Team',role,roles:[role],yard_location_ids:[28],yardLocationIds:[28]}};
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
try{
 await use({type:'special',record:special({stage:'await_customer_confirmation'}),alert:true},async({page})=>{
  await capture(page,'01-navigation',null,'Sales queue, filters and alerts');
  await page.locator('[data-special-sales-action="new"]').click();
  const form=page.locator('[data-special-case-form]');
  for(const [name,value] of Object.entries({customerName:'Example Landscaping',customerPhone:'416-555-0142',vendorName:'Example Stone Supply',remarks:'Customer needs charcoal slabs with a smooth finish.'}))await form.locator(`[name="${name}"]`).fill(value);
  await form.locator('[name="salesRepId"]').selectOption('123');await form.locator('[name="fulfillmentMethod"]').selectOption('yard_pickup');
  const line=form.locator('[data-special-composer-line]');
  for(const [name,value] of Object.entries({productName:'Architectural slab',color:'Charcoal',size:'24 × 24 in',detailSpec:'Smooth finish; matching batch',quantity:'2',rate:'520',discountPercent:'5',requiredDate:'2026-10-06',palletQty:'2',pieceQty:'40'}))await line.locator(`[name="${name}"]`).fill(value);
  await capture(page,'10-special-new-header','[data-special-case-form] > .stock-request-line-fields','Required customer, vendor, Sales Rep and expiry');
  await capture(page,'11-special-new-item','[data-special-composer-line]','Special item specification, selling price, dates and packaging');
 });
 await use({type:'regular',record:regular()},async({page})=>{
  await page.locator('[data-sales-stock-action="new"]').click();
  await page.locator('[data-regular-field="deliveryMethod"]').selectOption('delivery');
  for(const [name,value] of Object.entries({customerName:'Example Landscaping',arrivalDate:'2026-10-06',arrivalTime:'3pm'}))await page.locator(`[data-regular-field="${name}"]`).fill(value);
  await page.locator('[data-regular-field="arrivalTime"]').press('Tab');
  await page.locator('[data-sales-stock-field="itemSearch"]').fill('PAVER');await page.locator('[data-sales-stock-action="choose-item"]').first().click();
  await page.locator('[data-sales-stock-field="sourceLocationId"]').selectOption('1');await page.locator('[data-sales-stock-field="pallets"]').fill('2');
  await capture(page,'02-regular-form','[data-sales-stock-form]','Regular request with method, Toronto arrival and source-yard stock');
 });
 await use({role:'scm',record:regular({quantity:201}),alert:true},async({page})=>{
  await capture(page,'03-regular-scm','section.stock-request-detail','SCM review reason, safety stock and decisions');
 });
 await use({record:regular({approved:true,method:'pickup'}),preview:{choices:[],action:{mode:'location',salesOrderRef:'SOB-DEMO-201',sourceName:'3445',destinationName:'2967',lineCount:3,routes:[]},confirmationToken:'training-preview',approvalExpiresAt:new Date(Date.now()+900000).toISOString()}},async({page,state})=>{
  await capture(page,'04-regular-so','.regular-stock-so','Sales enters the SO created at the Sales yard');
  state.previewDelay=2200;
  await page.locator('[data-regular-so]').fill('SOB-DEMO-201');await page.locator('[data-sales-stock-action="link-so"]').click();
  await page.locator('dialog[data-state="busy"]').waitFor();await capture(page,'04b-regular-busy','dialog.regular-stock-dialog','Waiting for NetSuite — controls remain disabled');state.previewDelay=0;
  await page.locator('[data-regular-dialog-confirm]').waitFor();await capture(page,'05-regular-location-dialog','dialog.regular-stock-dialog','Confirm a single-source location change');
  await page.locator('[data-regular-dialog-cancel]').click();
  state.preview={choices:[],action:{mode:'transfer',salesOrderRef:'SOB-DEMO-201',destinationName:'2967',routes:[{sourceName:'3445',destinationName:'2967'},{sourceName:'150',destinationName:'2967'}]},confirmationToken:'training-transfer'};
  await page.locator('[data-sales-stock-action="link-so"]').click();await page.locator('[data-regular-dialog-confirm]').waitFor();await capture(page,'06-regular-to-dialog','dialog.regular-stock-dialog','Confirm transfer orders for multiple-source routing');
 });
 await use({record:regular({approved:true,expired:true})},async({page})=>capture(page,'07-regular-expired','.regular-stock-expired','Re-raise an unused expired Pickup or Delivery approval'));
 const pickup=regular({stocking:true});
 const pickupAction={mode:'pickup',requestRef:pickup.requestRef,destinationName:'2967',routes:[{sourceLocationId:1,sourceName:'3445',destinationName:'2967',palletQuantity:2,items:[{itemName:item.itemCode,quantity:180,unit:'SQFT'},{itemName:extra.itemCode,quantity:10,unit:'PC'}]}]};
 await use({role:'scm',record:pickup,preview:{action:pickupAction,lines:[{itemName:item.itemCode},{itemName:extra.itemCode}],evidence:{lines:[{remainingQuantity:820,safetyQuantity:800,shortfallQuantity:0,unit:'SQFT'},{remainingQuantity:990,safetyQuantity:400,shortfallQuantity:0,unit:'PC'}]},confirmationToken:'training-pickup'}},async({page})=>{
  await page.locator('[data-scm-stock-action="pickup-convert"]').click();
  await page.locator('[data-pickup-row="0"] [data-pickup-field="pallets"]').fill('1');await page.locator('[data-pickup-row="0"] [data-pickup-field="layers"]').fill('8');
  await page.locator('[data-pickup-search]').fill('WALL');await page.locator('[data-pickup-add]').waitFor();await capture(page,'08-pickup-autocomplete','dialog.scm-pickup-dialog','SCM edits quantities and finds additional items');
  await page.locator('[data-pickup-add]').click();await page.locator('[data-pickup-row="1"] [data-pickup-field="pieces"]').fill('10');await page.locator('[data-pickup-pallet="1"]').fill('2');
  await capture(page,'09-pickup-editor','dialog.scm-pickup-dialog','Final Stocking items and pallet quantity before review');
  await page.locator('[data-pickup-submit]').click();await page.locator('[data-regular-dialog-confirm]').waitFor();await capture(page,'09b-pickup-confirm','dialog.regular-stock-dialog','SCM confirms the direct TO action');
 });
 const done=regular({stocking:true});done.regular.pickupTransfer={status:'complete',plan:{action:pickupAction},completedAt:trainingDate,transfers:[{reference:'TO-DEMO-201',sourceName:'3445',destinationName:'2967'}]};done.bucket='accepted';done.lines[0].status='converted';
 await use({record:done},async({page})=>capture(page,'09c-pickup-history','.regular-stock-result','Saved Stocking quantities, TO reference and completion time'));
 await use({role:'scm',type:'special',record:special(),alert:true},async({page})=>{
  const form=page.locator('[data-special-stock-check-form]');await form.locator('[name="supplyStatus"]').selectOption('production');await form.locator('[name="availableDate"]').fill('2026-10-08');
  await form.locator('[name="salesVisibleNote"]').fill('Vendor expects stock on 8 October. Please confirm if the customer can wait.');
  await capture(page,'12-special-scm-stock','[data-special-stock-check-form]','SCM vendor check, ETA and separate Sales/internal notes');
 });
 const confirmation=special({waiting:true});confirmation.stage='await_customer_confirmation';
 await use({type:'special',record:confirmation},async({page})=>{
  await page.locator('[data-special-decision-line] [name="decision"]').selectOption('accepted');
  await page.locator('[data-special-decision-line] [name="customerNote"]').fill('Customer agrees to wait until 8 October.');
  await capture(page,'13-special-customer-decision','[data-special-decisions-form]','Record customer acceptance of the vendor ETA');
 });
 await use({type:'special',record:special({accepted:true,method:'mbt_delivery'})},async({page})=>{
  await capture(page,'14-special-so','.special-order-editor','Save the SO draft, then create or link the Sales Order');
  await capture(page,'14a-special-so-account','[data-special-so-form] > .stock-request-line-fields','SO customer account, Sales Rep and delivery details');
  await captureSpan(page,'14b-special-so-items','[data-special-so-form] h4','[data-special-link-so-form]','SO materials, pallets, charges and create/link actions');
 });
 await use({role:'scm',type:'special',record:special({accepted:true,so:true})},async({page})=>{
  await page.locator('[data-special-po-form] [name="vendorDiscountPercent"]').fill('10');
  await capture(page,'15-special-po','[data-special-po-form]','SCM confirms material quantities, vendor cost and vendor discount');
 });
 const pending=special({accepted:true,so:true,po:true});pending.purchaseOrderApproved=false;pending.purchaseOrderPendingApproval=true;pending.stage='confirmed';
 await use({role:'scm',type:'special',record:pending},async({page})=>{await capture(page,'16-special-po-approval','.stock-request-detail','PO approval holds the request at Confirmed');await captureSpan(page,'16a-special-po-approval','.stock-request-detail .stock-request-heading','.special-planning-status','PO approval status and separate Dispatch planning status');});
 const waiting=special({accepted:true,so:true,po:true,waiting:true});waiting.readinessAlerts=[{lineId:201,dueDate:'2026-10-05'}];
 await use({role:'scm',type:'special',record:waiting},async({page})=>capture(page,'17-special-readiness','[data-special-stock-check-form]','SCM readiness confirmation for a waiting order'));
 await use({type:'special',record:special({accepted:true,so:true,po:true,method:'mbt_delivery'})},async({page})=>capture(page,'18-special-delivery','[data-special-fulfillment-form]','Sales may update delivery details while the case remains unplanned'));
 await use({role:'scm',type:'special',record:special({accepted:true,so:true,po:true})},async({page})=>{
  await page.locator('[data-special-po-reference-form] [name="reference"]').fill('VENDOR-REF-301');
  await capture(page,'19-special-po-reference','[data-special-po-reference-form]','Shared PO reference and packing slip reference');
 });
 const adjustment=special({accepted:true,so:true,po:true});adjustment.quantityReviewPending=true;adjustment.quantityReview={mode:'issued',status:'pending',remoteStarted:false,lines:[{caseLineId:201,productName:'Architectural slab',fromPackageQuantity:2,toPackageQuantity:3,packageUom:'PLT',fromQuantity:40,toQuantity:60,salesUom:'PC',fromPurchaseQuantity:40,toPurchaseQuantity:60,purchaseUom:'PC',fromDiscountPercent:5,toDiscountPercent:5}],pallets:{fromQuantity:2,toQuantity:3,rate:35}};
 await use({role:'scm',type:'special',record:adjustment},async({page})=>capture(page,'20-special-adjustment','[data-special-quantity-review-form]','SCM review of changes to the issued SO and PO'));
 const closure=special({accepted:true,so:true,po:true});closure.closeStatus='closure_pending';closure.closureReason='Customer cancelled the project.';closure.closureReview={id:1,requiresScm:true,status:'pending',remoteStarted:false};
 await use({role:'scm',type:'special',record:closure},async({page})=>capture(page,'21-special-close','[data-special-closure-review-form]','SCM confirms or rejects closure of the linked SO and PO'));
 await use({type:'special',record:special({accepted:true,so:true,po:true,method:'vendor_pickup'})},async({page})=>{
  await page.locator('[data-special-vendor-pickup-form] [name="pickupReference"]').fill('Signed collection receipt — DEMO-301');
  await capture(page,'22-special-vendor-pickup','[data-special-vendor-pickup-form]','Record actual customer pickup at the vendor');
 });
 await use({role:'scm',type:'smart'},async({page})=>{
  await page.locator('[data-smart-tab="settings"]').click();
  await captureSpan(page,'23-regular-settings','#smartSettingsForm label:has([name="regularStockAutoApprovalEnabled"])','#smartSettingsForm label:has([name="regularStockLeadHours"])','Regular stock request approval settings');
  await page.locator('[data-smart-tab="plans"]').click();await capture(page,'24-regular-priority','.regular-priority-loads','Priority replenishment follows the request until SCM releases it');
 });
 assert.deepEqual(errors,[]);
 await writeFile(out+'/screenshots.json',JSON.stringify({captures,errors,source:'Deployed app UI, synthetic training fixtures, no live order writes'},null,2)+'\n');
 console.log(JSON.stringify({screenshots:captures.length,errors}));
}finally{await browser.close();}
