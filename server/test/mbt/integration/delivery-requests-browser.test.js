/* global window, document, localStorage, CustomEvent, DataTransfer, File, DragEvent, atob */
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import fc from 'fast-check';
import { request,window as slot,sales,dispatcher } from '../support/delivery-request-fixtures.js';
import {transitionDeliveryRequest} from '../../../src/delivery-request-domain.js';
let server,browser,base,row,instruction,alerts,commands,mediaBytes;
const quote = {id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',currency:'CAD',totalAmountMinor:47000,trips:2,capacityPerTrip:26,
  outbounds:[{originYardCode:'3445',sourceYardCodes:['3445','2967'],totalUnits:28,trips:2,rawDistanceMetres:20000,unitAmountMinor:23500,totalAmountMinor:47000,rateCardName:'MBBS'}]};
const json = (res,data,status=200) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
before(async () => {
  server = http.createServer(async (req,res) => {
    try {
      const path=new URL(req.url,'http://test').pathname;
      let body = {};
      if (['POST','PUT','DELETE'].includes(req.method) && path !== '/upload') {
        const chunks=[]; for await (const chunk of req) {chunks.push(chunk);}
        body=JSON.parse(Buffer.concat(chunks).toString() || '{}'); commands.push({path,body});
      }
      if (path.startsWith('/api/') || path === '/upload') {return serveApi(req,res,path,body);}
      await servePage(res,path);
    } catch {res.writeHead(404);res.end();}
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
function serveRequests(req,res,path,body) {
      if (path.endsWith('/delivery-requests/meta')) {return json(res,{requestingYards:[{id:1,code:'3445'}],outboundYards:['3445','2967','12441','150'],
        binTypes:[{code:'14YD',name:'14 Yard'}],settings:{pos:26,bin:1,approvalHours:3,reminderHours:1,revision:1}});}
      if (path.endsWith('/delivery-requests/quotes')) {return json(res,{...quote,pricing:body,outbounds:[{...quote.outbounds[0],originYardCode:body.pricingOriginYardCode}]},201);}
      if (path.endsWith('/delivery-requests/alerts')) {return json(res,{count:alerts.length,requests:alerts});}
      if (path.endsWith('/read')) {alerts=alerts.filter(item=>item.id!==1 || item.revision>body.revision);return json(res,{readRevision:body.revision});}
      if (path.startsWith('/api/') && path.endsWith('/delivery-requests')) {
        if (req.method==='POST') {row={...request(),...body,quote:{...quote,pricing:body,outbounds:[{...quote.outbounds[0],originYardCode:body.pricingOriginYardCode}]},id:1,requestRef:'DR-000001',history:[]};return json(res,row,201);}
        return json(res,{requests:row?[row]:[]});
      }
      if (/\/delivery-requests\/1$/.test(path)) {return json(res,row);}
      if (path.includes('/actions/')) {return serveAction(res,path,body);}
      return json(res,{},404);
}
function serveAction(res,path,body) {
  const action=path.split('/').at(-1);
  if(action.endsWith('-time-change') || action==='cancel') {
    const audience=path.includes('/dispatch/')?'dispatch':'sales';
    row=transitionDeliveryRequest(row,action,body,audience==='sales'?sales:dispatcher,audience);
  }
  if(action==='relink') {
    if(body.salesOrderRefs.includes('SOMISSING')) {return json(res,{error:'Sales Order not found.'},404);}
    row={...row,revision:row.revision+1,salesOrderRefs:body.salesOrderRefs};
  }
  if (action==='confirm') {row={...row,status:'preapproved',confirmedWindow:row.requestedWindow,revision:row.revision+1,approvalExpiresAt:new Date(Date.now()+10800000).toISOString(),reminderAt:new Date(Date.now()+7200000).toISOString()};}
  if (action==='secure') {row={...row,status:'confirmed',revision:row.revision+1,salesOrderRefs:body.salesOrderRefs,approvalExpiresAt:null,securedAt:new Date().toISOString()};}
  if (['edit','reraise'].includes(action)) {row={...row,...body,quote:{...quote,pricing:body},status:'submitted',revision:row.revision+1};}
  return json(res,row);
}
async function serveInstructions(req,res,path,body) {
      if (path.includes('/delivery-instructions') && /\/(?:SO12[3-6]|98700001)$/.test(path)) {
        if (req.method==='PUT') {instruction={...instruction,additionalText:body.additionalText,revision:instruction.revision+1};}
        return json(res,instruction);
      }
      if (path.endsWith('/media-ticket')) {return json(res,{uploadId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',upload:{uploadUrl:`${base}/upload`,token:'ticket'}},201);}
      if (path === '/upload') {
        const chunks=[];for await (const chunk of req) {chunks.push(chunk);}
        const multipart=Buffer.concat(chunks),boundary=String(req.headers['content-type']).split('boundary=')[1];
        const start=multipart.indexOf('\r\n\r\n')+4,end=multipart.indexOf(`\r\n--${boundary}`,start);
        mediaBytes=multipart.subarray(start,end);return json(res,{key:'sales/proof.jpg'});
      }
      if (path.endsWith('/media') && req.method==='POST') {
        instruction={...instruction,revision:instruction.revision+1,media:[{id:'proof',mimeType:body.mimeType,mediaKind:'image',fileName:body.fileName,contentUrl:'/proof.jpg'}]};
        return json(res,instruction,201);
      }
      if (path.includes('/media/proof') && req.method==='DELETE') {instruction={...instruction,revision:instruction.revision+1,media:[]};return json(res,instruction);}
      return json(res,{},404);
}
async function serveApi(req,res,path,body) {
  if (path === '/api/auth/me') {return json(res,{operator:req.headers.authorization?.includes('dispatch-token')?dispatcher:sales});}
  if (path.includes('/delivery-requests')) {return serveRequests(req,res,path,body);}
  return serveInstructions(req,res,path,body);
}
async function servePage(res,path) {
      if(path==='/proof.jpg') {res.setHeader('Content-Type','image/jpeg');res.end(mediaBytes);return;}
      if (path === '/alert-test') {
        res.setHeader('Content-Type','text/html');return res.end('<header class="topbar"><div class="actions"></div></header><button id="focus">Focus</button><script src="/delivery-request-alert.js"></script>');
      }
      const name = path.endsWith('/delivery-requests')?'delivery-requests.html':path.slice(1);
      if (!/^[a-z0-9.-]+$/.test(name)) {res.writeHead(404);return res.end();}
      const bytes = await fs.readFile(new URL(`../../../public/${name}`,import.meta.url));
      res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css':'text/html');res.end(bytes);
}
beforeEach(() => {row=null;alerts=[];commands=[];mediaBytes=Buffer.alloc(0);instruction={orderId:98700001,orderRef:'SO123',revision:0,additionalText:'',automatic:{text:'Call before delivery.'},media:[],editable:true};});
after(async () => {await browser?.close();server?.closeAllConnections();if(server) {await new Promise(resolve=>server.close(resolve));}});
async function pageFor(audience='sales') {
  const context=await browser.newContext({viewport:{width:1100,height:850},serviceWorkers:'block'});
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),`${audience}-token`);
  const page=await context.newPage();page.setDefaultTimeout(5000);
  if(process.env.DELIVERY_UI_COVERAGE==='1') {
    await page.coverage.startJSCoverage();
    const close=context.close.bind(context);
    context.close=async()=>{
      try {await fs.writeFile(`test-artifacts/delivery-requests-ui/browser-coverage-${++coverageIndex}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));}
      finally {await close();}
    };
  }
  return {page,context};
}
test('time change: Sales requests a valid free-text slot after linkage and can revise or withdraw while old time stays active',async()=>{
  row={...request(),quote,status:'confirmed',confirmedWindow:slot({start:'08:00',end:'09:00'}),salesOrderRefs:['SO123'],securedAt:'2028-10-01T12:00:00Z',history:[]};
  const {page,context}=await pageFor();
  try {
    await page.goto(`${base}/sales/delivery-requests?request=1`);
    const form=page.locator('[data-form="request-time-change"]');
    await expect(form).toBeVisible();
    assert.equal(await page.evaluate(()=>Boolean(document.querySelector('[data-form=relink]').compareDocumentPosition(document.querySelector('[data-form="request-time-change"]')) & 4)),true);
    await form.getByLabel('Start time',{exact:true}).fill('0800');await form.getByLabel('End time',{exact:true}).fill('0830');
    await expect(form.locator('[data-window-error]')).toContainText('at least 2 hours');
    await expect(form.getByRole('button',{name:'Request new timeslot',exact:true})).toBeDisabled();
    await form.getByLabel('New date').fill('2028-10-12');
    await form.getByLabel('Start time',{exact:true}).fill('1300');await form.getByLabel('End time',{exact:true}).fill('1500');
    await form.getByLabel('Reply (optional)').fill('Customer adjustment');
    await expect(form.getByLabel('End time',{exact:true})).toHaveValue('15:00');
    await form.getByRole('button',{name:'Request new timeslot',exact:true}).click();
    await expect(page.locator('[data-pending-window]')).toContainText('13:00–15:00');
    await expect(page.locator('[data-approved-window]')).toContainText('08:00–09:00');
    await expect(page.locator('[data-list]')).toContainText('Time change pending');
    await expect(page.locator('[data-approval-clock]')).toContainText('Secured');
    assert.equal(commands.filter(command=>command.path.endsWith('/request-time-change')).at(-1).body.window.start,'13:00');
    await page.reload();await expect(page.locator('[data-pending-window]')).toContainText('13:00–15:00');
    await form.getByLabel('Start time',{exact:true}).fill('1400');await form.getByLabel('End time',{exact:true}).fill('1600');
    await form.getByRole('button',{name:'Update requested timeslot',exact:true}).click();
    await expect(page.locator('[data-pending-window]')).toContainText('14:00–16:00');
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.screenshot({path:'test-artifacts/delivery-requests-ui/pending-time-change-sales.png',fullPage:true});
    await page.getByRole('button',{name:'Withdraw time change',exact:true}).click();
    await expect(page.locator('[data-pending-window]')).toHaveCount(0);
    await expect(page.locator('[data-approved-window]')).toContainText('08:00–09:00');
    assert.deepEqual(row.salesOrderRefs,['SO123']);
  } finally {await context.close();}
});
test('time change: Dispatch sees both windows and declines or accepts without Sales time-edit controls',async()=>{
  row={...request(),quote,status:'confirmed',confirmedWindow:slot({start:'08:00',end:'09:00'}),pendingWindow:slot({start:'13:00',end:'15:00'}),salesOrderRefs:['SO123'],history:[]};
  const {page,context}=await pageFor('dispatch');
  try {
    await page.goto(`${base}/dispatch/delivery-requests?request=1`);
    await expect(page.locator('[data-pending-window]')).toContainText('13:00–15:00');
    await expect(page.locator('[data-form="request-time-change"]')).toHaveCount(0);
    await page.getByRole('button',{name:'Decline time change',exact:true}).click();
    await expect(page.locator('[data-pending-window]')).toHaveCount(0);
    await expect(page.locator('[data-approved-window]')).toContainText('08:00–09:00');
    row={...row,pendingWindow:slot({start:'13:00',end:'15:00'}),revision:row.revision+1};
    await page.reload();
    await page.screenshot({path:'test-artifacts/delivery-requests-ui/pending-time-change-dispatch.png',fullPage:true});
    await page.getByRole('button',{name:'Accept new timeslot',exact:true}).click();
    await expect(page.locator('[data-approved-window]')).toContainText('13:00–15:00');
    await expect(page.locator('[data-pending-window]')).toHaveCount(0);
    await expect(page.locator('[data-approval-clock]')).toContainText('Secured');
  } finally {await context.close();}
});
test('Dispatch counter: both teams negotiate a secured time on desktop and mobile',async()=>{
  for(const width of [1100,390]) {
    row={...request(),quote,status:'confirmed',confirmedWindow:slot({start:'08:00',end:'09:00'}),
      pendingWindow:slot({start:'13:00',end:'15:00'}),salesOrderRefs:['SO123'],history:[]};
    const dispatchPage=await pageFor('dispatch');
    try {
      await dispatchPage.page.goto(`${base}/dispatch/delivery-requests?request=1`);
      await dispatchPage.page.setViewportSize({width,height:850});
      const form=dispatchPage.page.locator('[data-form="counter-time-change"]');await expect(form).toBeVisible();
      await form.locator('[name="start"]').fill('15:00');await form.locator('[name="end"]').fill('17:00');
      await form.getByRole('button',{name:'Counter-propose timeslot',exact:true}).click();
      await expect(dispatchPage.page.locator('[data-pending-window]')).toContainText('15:00');
      await expect(dispatchPage.page.locator('[data-detail]')).toContainText('Awaiting Sales');
      await expect(dispatchPage.page.getByRole('button',{name:'Accept new timeslot',exact:true})).toHaveCount(0);
      assert.equal(row.confirmedWindow.start,'08:00');assert.deepEqual(row.salesOrderRefs,['SO123']);
      assert.ok(await dispatchPage.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
    } finally {await dispatchPage.context.close();}
    const salesPage=await pageFor('sales');
    try {
      await salesPage.page.goto(`${base}/sales/delivery-requests?request=1`);
      await salesPage.page.setViewportSize({width,height:850});
      await expect(salesPage.page.locator('[data-pending-window]')).toContainText('Dispatch counter-proposal');
      await salesPage.page.getByRole('button',{name:'Accept Dispatch timeslot',exact:true}).click();
      await expect(salesPage.page.locator('[data-pending-window]')).toHaveCount(0);
      assert.equal(row.confirmedWindow.start,'15:00');assert.equal(row.confirmedWindow.end,'17:00');
      assert.equal(row.status,'confirmed');assert.deepEqual(row.salesOrderRefs,['SO123']);
      assert.ok(await salesPage.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
    } finally {await salesPage.context.close();}
  }
});
test('time change: failed submission preserves the entered slot; cancellation visibly releases linked SOs',async()=>{
  row={...request(),quote,status:'confirmed',confirmedWindow:slot(),salesOrderRefs:['SO123'],history:[]};
  const {page,context}=await pageFor();
  try {
    await page.goto(`${base}/sales/delivery-requests?request=1`);
    await page.route('**/actions/request-time-change',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Please retry.'})}));
    const form=page.locator('[data-form="request-time-change"]');
    await form.getByLabel('Start time',{exact:true}).fill('1300');await form.getByLabel('End time',{exact:true}).fill('1500');
    await form.getByRole('button',{name:'Request new timeslot',exact:true}).click();
    await expect(page.locator('[data-notice]')).toContainText('Please retry.');
    await expect(form.getByLabel('Start time',{exact:true})).toHaveValue('13:00');
    await expect(page.locator('[data-approved-window]')).toContainText('09:00–12:00');
    await page.getByRole('button',{name:'Cancel request',exact:true}).click();
    await expect(page.locator('[data-approval-clock]')).toHaveText('Cancelled · linked orders released.');
    await expect(page.locator('[data-linked-order]')).toHaveCount(0);assert.deepEqual(row.salesOrderRefs,[]);
  } finally {await context.close();}
});
test('time change: global notifications describe requests, decisions and released SOs on other pages',async()=>{
  const messages={'request-time-change':'approved time remains active until Dispatch accepts',
    'accept-time-change':'approved delivery time has been updated',
    'decline-time-change':'approved delivery time is unchanged',
    'withdraw-time-change':'approved delivery time is unchanged',cancel:'Linked orders have been released'};
  for(const [action,message] of Object.entries(messages)) {
    alerts=[{id:1,requestRef:'DR-000001',revision:8,status:'confirmed',action}];
    const {page,context}=await pageFor(action==='request-time-change'?'dispatch':'sales');
    try {
      await page.goto(`${base}/alert-test`);
      await expect(page.locator('.delivery-request-dialog')).toContainText(message);
      await page.getByRole('button',{name:'Close',exact:true}).click();
      assert.equal(commands.filter(command=>command.path.endsWith('/read')).length,0);
    } finally {await context.close();}
  }
});
test('linkage: Sales exchanges and unlinks with one required SO, retaining typed replacements on failure',async()=>{
  row={...request(),quote,status:'confirmed',confirmedWindow:slot({start:'08:00',end:'09:00'}),salesOrderRefs:['SO123','SO124'],history:[]};
  const {page,context}=await uiPage();
  try {
    await page.goto(`${base}/sales/delivery-requests?request=1`);
    await page.getByRole('button',{name:'Unlink SO124',exact:true}).click();
    await expect(page.getByRole('button',{name:'Unlink SO123',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Exchange SO123',exact:true}).click();
    await page.getByLabel('Order 1 (SO / TO)',{exact:true}).fill('SOMISSING');
    await page.getByRole('button',{name:'Save order links',exact:true}).click();
    await expect(page.locator('[data-notice]')).toContainText('Sales Order not found');
    await expect(page.getByLabel('Order 1 (SO / TO)',{exact:true})).toHaveValue('SOMISSING');
    assert.deepEqual(row.salesOrderRefs,['SO123','SO124']);
    await page.getByLabel('Order 1 (SO / TO)',{exact:true}).fill('SO125');
    await page.getByRole('button',{name:'Add order',exact:true}).click();
    await page.getByLabel('Order 2 (SO / TO)',{exact:true}).fill('SO126');
    await page.getByRole('button',{name:'Save order links',exact:true}).click();
    await expect(page.locator('[data-approval-clock]')).toContainText('SO125, SO126');
    assert.deepEqual(commands.filter(command=>command.path.endsWith('/relink')).at(-1).body.salesOrderRefs,['SO125','SO126']);
    assert.equal(row.confirmedWindow.end,'09:00');
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.screenshot({path:'test-artifacts/delivery-requests-ui/secured-link-exchange.png',fullPage:true});
  } finally {await closeUiPage(page,context);}
});
test('linkage: Dispatch can see linked orders without Sales edit controls',async()=>{
  row={...request(),quote,status:'confirmed',confirmedWindow:slot(),salesOrderRefs:['SO123'],history:[]};
  const {page,context}=await pageFor('dispatch');
  try {
    await page.goto(`${base}/dispatch/delivery-requests?request=1`);
    await expect(page.locator('[data-linked-order]')).toHaveValue('SO123');
    await expect(page.getByRole('button',{name:'Save order links',exact:true})).toHaveCount(0);
  } finally {await context.close();}
});
test('trip types: Sales enters and saves ordered multi-stop addresses and quantities and route edits invalidate the quote',async()=>{
  const {page,context}=await pageFor();
  try {
    await page.goto(`${base}/sales/delivery-requests`);
    await page.getByRole('button',{name:'New request',exact:true}).click();
    await expect(page.getByLabel('Trip type',{exact:true})).toHaveValue('single');
    await page.getByLabel('Trip type',{exact:true}).selectOption('round_trip');
    await expect(page.locator('[data-detail]')).toContainText('return leg');
    await page.getByLabel('Trip type',{exact:true}).selectOption('multi_stop');
    await expect(page.locator('[data-trip-leg]')).toHaveCount(2);
    const first=page.locator('[data-trip-leg]').nth(0),last=page.locator('[data-trip-leg]').nth(1);
    await first.getByLabel('Pickup MBBS yard').selectOption('3445');await first.getByLabel('Drop-off address').fill('200 Dropoff Road');await first.getByLabel('Quantity (POS)').fill('10');
    await last.getByLabel('Pickup address').fill('200 Dropoff Road');await last.getByLabel('Drop-off MBBS yard').selectOption('2967');await last.getByLabel('Quantity (POS)').fill('30');
    await page.getByRole('button',{name:'Add trip leg',exact:true}).click();await expect(page.locator('[data-trip-leg]')).toHaveCount(3);
    await expect(page.locator('[data-trip-leg]').nth(2).getByLabel('Drop-off MBBS yard')).toHaveValue('2967');
    await page.getByRole('button',{name:'Remove leg 2',exact:true}).click();
    await page.getByLabel('Requested date').fill('2028-10-10');
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();await expect(page.locator('[data-quote-total]')).toBeVisible();
    await page.locator('[data-trip-leg]').nth(1).getByLabel('Drop-off MBBS yard').selectOption('12441');
    await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    await page.getByRole('button',{name:'Submit request',exact:true}).click();await expect(page.locator('[data-detail]')).toContainText('Multi-stop trip');
    assert.equal(row.tripType,'multi_stop');assert.deepEqual(row.tripLegs.map(leg=>leg.totalUnits),[10,30]);
    assert.equal(row.tripLegs[1].dropoffYardCode,'12441');assert.equal(row.tripLegs[0].pickupYardCode,'3445');assert.equal(row.totalUnits,40);
    await page.screenshot({path:'test-artifacts/delivery-requests-ui/multi-stop-request.png',fullPage:true});
  } finally {await context.close();}
});
test('Sales calculates a shared-yard quote and must recalculate after changing pricing inputs',async () => {
  const {page,context}=await pageFor();
  try {
    await page.goto(`${base}/sales/delivery-requests`);
    await page.getByRole('button',{name:'New request',exact:true}).click();
    await page.getByLabel('Delivery address').fill('100 Test Road, Toronto');
    await page.getByLabel('Full POS qty',{exact:true}).fill('27');
    await page.getByRole('button',{name:'Add outbound yard',exact:true}).click();
    await page.getByRole('combobox',{name:'Outbound yard'}).nth(1).selectOption('2967');
    await page.getByLabel('Full POS qty',{exact:true}).nth(1).fill('1');
    await page.getByLabel('Requested date').fill('2028-10-10');
    await page.getByLabel('Start time',{exact:true}).fill('09:00');await page.getByLabel('End time',{exact:true}).fill('12:00');
    await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    await expect(page.locator('[data-quote-total]')).toContainText('470.00');
    await page.screenshot({path:'test-artifacts/delivery-requests/sales-quote.png',fullPage:true});
    await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeEnabled();
    await page.getByLabel('Delivery address').fill('200 Changed Road');
    await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    await page.getByRole('button',{name:'Submit request',exact:true}).click();
    await expect(page.getByRole('heading',{name:'DR-000001',exact:true})).toBeVisible();
    const submitted=commands.find(command=>command.path==='/api/sales/delivery-requests');
    assert.equal(submitted.body.outbounds.length,2);assert.equal(submitted.body.quoteId,quote.id);
  } finally {await context.close();}
});
test('preapproved Sales enters multiple SOs then edits instructions and drops compressed media on the same page',async () => {
  row={...request(),quote,status:'preapproved',confirmedWindow:slot(),approvalExpiresAt:new Date(Date.now()+10800000).toISOString(),history:[]};
  const {page,context}=await pageFor();
  try {
    await page.goto(`${base}/sales/delivery-requests?request=1`);
    await expect(page.locator('[data-approval-clock]')).toContainText('expires');
    await page.getByLabel('Order 1 (SO / TO)',{exact:true}).fill('SO123');
    await page.getByRole('button',{name:'Add order',exact:true}).click();
    await page.getByLabel('Order 2 (SO / TO)',{exact:true}).fill('SO124');
    await page.getByRole('button',{name:'Secure approval',exact:true}).click();
    await expect(page.locator('[data-approval-clock]')).toContainText('Secured');
    assert.deepEqual(commands.find(command=>command.path.endsWith('/secure')).body.salesOrderRefs,['SO123','SO124']);
    await page.getByLabel('Extra delivery instructions').fill('Leave by the rear gate.');
    await page.getByRole('button',{name:'Save instructions',exact:true}).click();
    await expect(page.locator('[data-notice]')).toContainText('Delivery instructions saved.');
    assert.equal(instruction.additionalText,'Leave by the rear gate.');
    await page.locator('[data-media-drop]').evaluate(element=>{
      const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/aEAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
      const data=new DataTransfer();data.items.add(new File([bytes],'proof.png',{type:'image/png'}));
      element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));
    });
    await expect(page.locator('[data-instruction-media]')).toHaveCount(1);
    await page.screenshot({path:'test-artifacts/delivery-requests/sales-secured-instructions.png',fullPage:true});
    assert.equal(commands.find(command=>command.path.endsWith('/media-ticket')).body.mimeType,'image/jpeg');
    assert.equal(commands.find(command=>command.path.endsWith('/media')).body.expectedRevision,1);
  } finally {await context.close();}
});
test('Dispatch sees the request and OK creates a preapproval with an expiry clock',async () => {
  row={...request(),quote,history:[]};const {page,context}=await pageFor('dispatch');
  try {
    await page.goto(`${base}/dispatch/delivery-requests?request=1`);
    await page.getByRole('button',{name:'OK — preapprove',exact:true}).click();
    await expect(page.locator('[data-approval-clock]')).toContainText('expires');
    assert.equal(row.status,'preapproved');
    await expect(page.locator('[data-form=secure]')).toHaveCount(0);
  } finally {await context.close();}
});
test('popup Close preserves topbar unread and Open request acknowledges only the displayed revision',async () => {
  alerts=[{id:1,requestRef:'DR-000001',revision:2,status:'preapproved',action:'confirm'}];
  const {page,context}=await pageFor();
  try {
    await page.goto(`${base}/alert-test`);
    await expect(page.locator('.delivery-request-alert')).toContainText('1');
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await expect(page.locator('.delivery-request-alert')).toContainText('1');
    assert.equal(commands.filter(command=>command.path.endsWith('/read')).length,0);
    await page.reload();await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
    alerts=[{...alerts[0],revision:3,action:'remind'}];
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    await page.getByRole('link',{name:'Open request',exact:true}).click();
    assert.equal(commands.find(command=>command.path.endsWith('/read')).body.revision,3);
  } finally {await context.close();}
});
test('alerts defer to another dialog and clear immediately when the user logs out',async () => {
  const {page,context}=await pageFor();
  try {
    await page.goto(`${base}/alert-test`);
    await page.evaluate(()=>{const dialog=document.createElement('dialog');dialog.id='other';document.body.append(dialog);dialog.showModal();});
    alerts=[{id:1,requestRef:'DR-000001',revision:2,status:'preapproved',action:'confirm'}];
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
    await page.evaluate(()=>document.querySelector('#other').close());
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    await page.evaluate(()=>{localStorage.removeItem('mbbs.staff.token');window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed',{detail:{operator:null}}));});
    await expect(page.locator('.delivery-request-alert')).toHaveCount(0);await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
  } finally {await context.close();}
});

let coverageIndex=0;
async function uiPage(audience='sales') {
  return pageFor(audience);
}
async function closeUiPage(_page,context) {await context.close();}
async function openNewForm(page) {
  await page.goto(`${base}/sales/delivery-requests`);
  await page.getByRole('button',{name:'New request',exact:true}).click();
}
async function assertSameRow(page,labels) {
  const boxes=await Promise.all(labels.map(label=>page.getByLabel(label).boundingBox()));
  assert.ok(boxes.every(Boolean));
  assert.ok(boxes.every(box=>Math.abs(box.y-boxes[0].y)<2),`${labels.join(', ')} must share one row`);
  assert.ok(boxes.every((box,index)=>index===0 || box.x>boxes[index-1].x),'Fields retain their left-to-right order');
}
test('UI: page actions work outside the navigation header for Sales and Dispatch',async()=>{
  for(const audience of ['sales','dispatch']) {
    const {page,context}=await uiPage(audience);
    try {
      await page.goto(`${base}/${audience}/delivery-requests`);
      await expect(page.locator('.dispatch-topbar [data-action=refresh],.dispatch-topbar [data-action=new]')).toHaveCount(0);
      const refresh=page.getByRole('button',{name:'Refresh',exact:true});
      await expect(refresh).toBeVisible();
      if(audience==='sales') {
        await page.getByRole('button',{name:'New request',exact:true}).click();
        await page.getByLabel('Customer (optional)').fill('Draft survives refresh');
      } else {await expect(page.getByRole('button',{name:'New request',exact:true})).toHaveCount(0);}
      const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/${audience}/delivery-requests` && r.request().method()==='GET');
      await refresh.click();await response;
      if(audience==='sales') {await expect(page.getByLabel('Customer (optional)')).toHaveValue('Draft survives refresh');}
    } finally {await closeUiPage(page,context);}
  }
});
test('UI: desktop POS and BIN keep the requested field groups in three columns',async()=>{
  const {page,context}=await uiPage();
  try {
    await page.setViewportSize({width:1440,height:900});await openNewForm(page);
    for(const type of ['pos','bin']) {
      await page.getByLabel('Load type').selectOption(type);
      await assertSameRow(page,['Requesting yard','Load type','Customer (optional)']);
      await assertSameRow(page,['Requested date','Start time','End time']);
      if(type==='bin') {
        const bin=await page.getByLabel('BIN size').boundingBox();
        const customer=await page.getByLabel('Customer (optional)').boundingBox();
        assert.ok(bin.y>customer.y,'BIN size follows the first row');
      }
    }
    await page.screenshot({path:'test-artifacts/delivery-requests-ui/desktop-form.png',fullPage:true});
  } finally {await closeUiPage(page,context);}
});
test('UI: document scroll reaches lower form actions on desktop and mobile',async()=>{
  const {page,context}=await uiPage();
  try {
    await openNewForm(page);
    for(const viewport of [{width:1440,height:600},{width:390,height:650}]) {
      await page.setViewportSize(viewport);await page.evaluate(()=>window.scrollTo(0,0));
      const geometry=await page.evaluate(()=>({overflow:window.getComputedStyle(document.body).overflowY,height:document.scrollingElement.scrollHeight,width:document.scrollingElement.scrollWidth}));
      assert.ok(['auto','scroll','visible'].includes(geometry.overflow),'Body permits document scrolling');
      assert.ok(geometry.height>viewport.height,'Form extends below the viewport');
      assert.ok(geometry.width<=viewport.width,'No horizontal overflow');
      await page.mouse.move(viewport.width-40,viewport.height-80);await page.mouse.wheel(0,4000);
      await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBeGreaterThan(0);
      await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeInViewport();
      await expect(page.getByRole('button',{name:'Close',exact:true})).toBeInViewport();
      if(viewport.width===390) {
        const panel=await page.locator('[data-detail]').boundingBox();
        assert.ok(panel.width>=viewport.width-100,'Phone form uses the available screen width');
        const date=await page.getByLabel('Requested date').boundingBox(),start=await page.getByLabel('Start time',{exact:true}).boundingBox();
        assert.ok(start.y>date.y,'Phone timeslot fields stack');
        await page.screenshot({path:'test-artifacts/delivery-requests-ui/mobile-form.png',fullPage:true});
      }
    }
  } finally {await closeUiPage(page,context);}
});
test('UI: each outbound yard supplies the quote and submission origin automatically',async()=>{
  const {page,context}=await uiPage();
  try {
    await openNewForm(page);await page.getByLabel('Delivery address').fill('1210 Pelican Pass, Oakville, ON L6H 7G1');
    await page.getByLabel('Requested date').fill('2028-10-10');
    for(const code of ['3445','2967','12441','150']) {
      await page.getByRole('combobox',{name:'Outbound yard'}).selectOption(code);
      await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
      await expect(page.locator('[data-quote-total]')).toBeVisible();
      const calculated=commands.filter(command=>command.path.endsWith('/quotes')).at(-1).body;
      assert.equal(calculated.pricingOriginYardCode,code);
      await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeEnabled();
    }
    await expect(page.getByLabel('Distance pricing origin')).toHaveCount(0);
    await page.getByRole('button',{name:'Submit request',exact:true}).click();
    await expect(page.getByRole('heading',{name:'DR-000001',exact:true})).toBeVisible();
    assert.equal(commands.find(command=>command.path==='/api/sales/delivery-requests').body.pricingOriginYardCode,'150');
  } finally {await closeUiPage(page,context);}
});
test('UI: randomized outbound orders derive the first yard and invalidate stale quotes',async()=>{
  const {page,context}=await uiPage();
  try {
    await openNewForm(page);
    await fc.assert(fc.asyncProperty(fc.shuffledSubarray(['3445','2967','12441','150'],{minLength:1,maxLength:4}),async codes=>{
      await page.getByRole('button',{name:'New request',exact:true}).click();
      await page.getByLabel('Delivery address').fill('100 Test Road, Toronto');
      for(const [index,code] of codes.entries()) {
        if(index) {await page.getByRole('button',{name:'Add outbound yard',exact:true}).click();}
        await page.getByRole('combobox',{name:'Outbound yard'}).nth(index).selectOption(code);
      }
      await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
      await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeEnabled();
      assert.equal(commands.filter(command=>command.path.endsWith('/quotes')).at(-1).body.pricingOriginYardCode,codes[0]);
      await page.getByRole('combobox',{name:'Outbound yard'}).first().selectOption(codes[0]==='150'?'3445':'150');
      await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeDisabled();
      await expect(page.locator('[data-quote]')).toContainText('Calculate the charge again');
    }),{seed:6102026,numRuns:16}).catch(async error=>{
      await fs.writeFile('test-artifacts/delivery-requests-ui/property-failure.json',JSON.stringify({message:error.message,cause:error.cause?.stack,commands:commands.slice(-6)},null,2));
      throw error;
    });
  } finally {await closeUiPage(page,context);}
});
test('UI: edit and re-raise follow the physical outbound instead of an old pricing origin',async()=>{
  for(const [status,action] of [['submitted','Edit request'],['expired','Re-raise request']]) {
    row={...request({outbounds:[{originYardCode:'2967',totalUnits:1}],pricingOriginYardCode:'3445',status}),quote,history:[]};
    const {page,context}=await uiPage();
    try {
      await page.goto(`${base}/sales/delivery-requests?request=1`);
      await page.getByRole('button',{name:action,exact:true}).click();
      await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
      await expect(page.locator('[data-quote-total]')).toBeVisible();
      assert.equal(commands.filter(command=>command.path.endsWith('/quotes')).at(-1).body.pricingOriginYardCode,'2967');
      await page.getByRole('button',{name:status==='expired'?'Re-raise request':'Save request',exact:true}).click();
      await expect(page.getByRole('heading',{name:'DR-000001',exact:true})).toBeVisible();
      assert.equal(commands.filter(command=>command.path.endsWith(status==='expired'?'/reraise':'/edit')).at(-1).body.pricingOriginYardCode,'2967');
    } finally {await closeUiPage(page,context);}
  }
});
test('UI: multiple status checkboxes survive search and refresh and clearing means all',async()=>{
  for(const audience of ['sales','dispatch']) {
    const {page,context}=await uiPage(audience);
    try {
      await page.goto(`${base}/${audience}/delivery-requests`);
      await page.locator('.dr-status-filter summary').click();
      for(const label of ['Awaiting Dispatch','Secured']) {
        const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/${audience}/delivery-requests`);
        await page.getByRole('checkbox',{name:label,exact:true}).check();await response;
      }
      const selectedRequest=page.waitForRequest(r=>new URL(r.url()).pathname===`/api/${audience}/delivery-requests`);
      await page.getByLabel('Search requests').fill('Pelican');
      let url=new URL((await selectedRequest).url());
      assert.deepEqual(url.searchParams.getAll('status'),['submitted','confirmed']);assert.equal(url.searchParams.get('search'),'Pelican');
      const refreshed=page.waitForRequest(r=>new URL(r.url()).pathname===`/api/${audience}/delivery-requests`);
      await page.getByRole('button',{name:'Refresh',exact:true}).click();
      url=new URL((await refreshed).url());assert.deepEqual(url.searchParams.getAll('status'),['submitted','confirmed']);
      for(const label of ['Awaiting Dispatch','Secured']) {
        const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/${audience}/delivery-requests`);
        await page.getByRole('checkbox',{name:label,exact:true}).uncheck();await response;
      }
      const cleared=page.waitForRequest(r=>new URL(r.url()).pathname===`/api/${audience}/delivery-requests`);
      await page.getByRole('button',{name:'Refresh',exact:true}).click();
      assert.deepEqual(new URL((await cleared).url()).searchParams.getAll('status'),[]);
      await expect(page.locator('[data-status-summary]')).toHaveText('All statuses');
    } finally {await closeUiPage(page,context);}
  }
});
test('UI: draft and saved trip rows show escaped addresses and transfer destinations',async()=>{
  const {page,context}=await uiPage();
  const address='1210 Pelican Pass, Oakville, ON L6H 7G1';
  try {
    await openNewForm(page);await page.getByRole('combobox',{name:'Outbound yard'}).selectOption('150');
    await page.getByLabel('Delivery address').fill(address);await page.getByLabel('Requested date').fill('2028-10-10');
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    await expect(page.locator('.dr-quote tbody')).toContainText(`150 → ${address}`);
    await page.getByRole('button',{name:'Submit request',exact:true}).click();
    await expect(page.getByRole('heading',{name:'DR-000001',exact:true})).toBeVisible();
    await expect(page.locator('.dr-quote tbody')).toContainText(`150 → ${address}`);
    row={...row,deliveryAddress:'Gate <img src=x onerror=alert(1)> & loading bay',quote:{...quote,pricing:{deliveryAddress:'Gate <img src=x onerror=alert(1)> & loading bay'},outbounds:[
      {...quote.outbounds[0],legType:'transfer',originYardCode:'150',destinationYardCode:'3445'},
      {...quote.outbounds[0],legType:'delivery',originYardCode:'3445'}]}};
    await page.getByRole('button',{name:'Refresh request',exact:true}).click();
    await expect(page.locator('.dr-quote tbody')).toContainText('150 → 3445');
    await expect(page.locator('.dr-quote tbody')).toContainText('3445 → Gate <img src=x onerror=alert(1)> & loading bay');
    await expect(page.locator('.dr-quote tbody img')).toHaveCount(0);
  } finally {await closeUiPage(page,context);}
});
test('UI: the delivery page reports its displayed revision and alerts later Dispatch replies',async()=>{
  row={...request(),quote,history:[]};
  const {page,context}=await uiPage();
  try {
    await page.goto(`${base}/sales/delivery-requests?request=1`);
    await expect(page.getByRole('heading',{name:'DR-000001',exact:true})).toBeVisible();
    assert.deepEqual(await page.evaluate(()=>window.MBBSDeliveryRequestPage),{currentRequestId:1,currentRequestRevision:1});
    alerts=[{id:1,requestRef:'DR-000001',revision:2,action:'propose',status:'proposed'}];
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toContainText('proposed another timeslot');
    await page.getByRole('button',{name:'Close',exact:true}).click();
    row={...row,revision:2,status:'proposed',proposedWindow:slot({start:'13:00',end:'15:00'})};
    await page.getByRole('button',{name:'Refresh request',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.MBBSDeliveryRequestPage.currentRequestRevision)).toBe(2);
    await expect(page.locator('.delivery-request-alert')).toBeHidden();
    alerts=[{id:1,requestRef:'DR-000001',revision:3,action:'confirm',status:'preapproved'}];
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toContainText('pre-approved delivery');
  } finally {await closeUiPage(page,context);}
});

test('updates: one SO per input, adjacent add/remove controls and linkage before time changes on desktop and mobile',async()=>{
  row={...request(),quote,status:'preapproved',confirmedWindow:slot(),approvalExpiresAt:new Date(Date.now()+10800000).toISOString(),history:[]};
  const {page,context}=await pageFor();
  try {
    await page.goto(`${base}/sales/delivery-requests?request=1`);
    const linkage=page.locator('[data-form=secure]');
    await expect(linkage.locator('input[name=salesOrderRefs]')).toHaveCount(1);
    for(const viewport of [{width:1440,height:850},{width:390,height:750}]) {
      await page.setViewportSize(viewport);
      const first=await page.getByLabel('Order 1 (SO / TO)',{exact:true}).boundingBox();
      const plus=await linkage.getByRole('button',{name:'Add order',exact:true}).boundingBox();
      const counter=await page.locator('[data-form=counter]').boundingBox();
      assert.ok(first.y<counter.y,'SO linkage appears before the time-change form');
      assert.ok(plus.x>=first.x+first.width && Math.abs(plus.y-first.y)<5,'Plus stays next to the SO input');
      assert.ok(await page.evaluate(()=>document.scrollingElement.scrollWidth<=window.innerWidth),'No horizontal overflow');
    }
    await page.getByLabel('Order 1 (SO / TO)',{exact:true}).fill('so123');
    await linkage.getByRole('button',{name:'Add order',exact:true}).click();
    await expect(page.getByLabel('Order 2 (SO / TO)',{exact:true})).toBeFocused();
    await page.getByLabel('Order 2 (SO / TO)',{exact:true}).fill('SO124');
    await linkage.getByRole('button',{name:'Add order',exact:true}).last().click();
    await page.getByLabel('Order 3 (SO / TO)',{exact:true}).fill('SO999');
    await linkage.getByRole('button',{name:'Remove order 2',exact:true}).click();
    await expect(page.getByLabel('Order 1 (SO / TO)',{exact:true})).toHaveValue('so123');
    await expect(page.getByLabel('Order 2 (SO / TO)',{exact:true})).toHaveValue('SO999');
    await page.getByLabel('Order 2 (SO / TO)',{exact:true}).fill('SO124');
    await page.screenshot({path:'test-artifacts/delivery-requests-ui/mobile-so-linkage.png',fullPage:true});
    await page.getByRole('button',{name:'Secure approval',exact:true}).click();
    assert.deepEqual(commands.find(command=>command.path.endsWith('/secure')).body.salesOrderRefs,['SO123','SO124']);
  } finally {await context.close();}
});
test('updates: request submission blocks a 119-minute slot and accepts exactly two hours',async()=>{
  const {page,context}=await pageFor();
  try {
    await page.goto(`${base}/sales/delivery-requests`);
    await page.getByRole('button',{name:'New request',exact:true}).click();
    await page.getByLabel('Delivery address').fill('100 Test Road, Toronto');
    await page.getByLabel('Requested date').fill('2028-10-10');
    await page.getByLabel('Start time',{exact:true}).fill('09:00');
    await page.getByLabel('End time',{exact:true}).fill('10:59');
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeDisabled();
    await expect(page.locator('[data-window-error]')).toContainText('at least 2 hours');
    await page.locator('[data-form=request]').evaluate(form=>form.requestSubmit());
    assert.equal(commands.filter(command=>command.path==='/api/sales/delivery-requests').length,0);
    assert.match(await page.getByLabel('End time',{exact:true}).evaluate(input=>input.validationMessage),/at least 2 hours/);
    await page.getByLabel('End time',{exact:true}).fill('11:00');
    await page.getByRole('button',{name:'Submit request',exact:true}).click();
    await expect(page.getByRole('heading',{name:'DR-000001',exact:true})).toBeVisible();
    assert.equal(commands.find(command=>command.path==='/api/sales/delivery-requests').body.requestedWindow.end,'11:00');
  } finally {await context.close();}
});
for(const [audience,status,kind] of [['dispatch','submitted','propose'],['sales','preapproved','counter']]) {
  test(`updates: ${kind} validates both start and end changes before sending`,async()=>{
    row={...request(),quote,status,confirmedWindow:status==='preapproved'?slot():null,approvalExpiresAt:new Date(Date.now()+10800000).toISOString(),history:[]};
    const {page,context}=await pageFor(audience);
    try {
      await page.goto(`${base}/${audience}/delivery-requests?request=1`);
      const form=page.locator(`[data-form=${kind}]`);
      await form.getByLabel('End time',{exact:true}).fill('11:00');
      await form.getByLabel('Start time',{exact:true}).fill('09:01');
      await expect(form.locator('button')).toBeDisabled();
      await expect(form.locator('[data-window-error]')).toContainText('at least 2 hours');
      await form.evaluate(element=>element.requestSubmit());
      assert.equal(commands.filter(command=>command.path.endsWith(`/actions/${kind}`)).length,0);
      assert.match(await form.getByLabel('End time',{exact:true}).evaluate(input=>input.validationMessage),/at least 2 hours/);
      await form.getByLabel('Start time',{exact:true}).fill('09:00');
      await form.locator('button').click();
      await expect.poll(()=>commands.filter(command=>command.path.endsWith(`/actions/${kind}`)).length).toBe(1);
    } finally {await context.close();}
  });
}

test('timeslot frontend: compact free text warns while typing and formats only on change',async()=>{
  const {page,context}=await pageFor();
  try {
    await openNewForm(page);
    await page.getByLabel('Delivery address').fill('100 Test Road, Toronto');
    await page.getByLabel('Requested date').fill('2028-10-10');
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    const start=page.getByLabel('Start time',{exact:true}),end=page.getByLabel('End time',{exact:true});
    const submit=page.getByRole('button',{name:'Submit request',exact:true}),error=page.locator('[data-window-error]');
    await expect(start).toHaveAttribute('type','text');await expect(end).toHaveAttribute('type','text');
    await start.fill('0800');await expect(start).toHaveValue('0800');
    await end.fill('0830');await expect(start).toHaveValue('08:00');
    await expect(end).toHaveValue('0830');await expect(error).toBeVisible();
    await expect(error).toContainText('at least 2 hours');await expect(submit).toBeDisabled();
    await expect(end).toHaveAttribute('aria-invalid','true');
    await end.press('Tab');await expect(end).toHaveValue('08:30');
    await expect(submit).toBeDisabled();
    await page.locator('[data-form=request]').evaluate(form=>form.requestSubmit());
    assert.equal(commands.filter(command=>command.path==='/api/sales/delivery-requests').length,0);
    await page.locator('[data-detail]').screenshot({path:'test-artifacts/delivery-requests-ui/timeslot-warning.png'});
    await end.fill('1000');await expect(error).toBeHidden();await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole('heading',{name:'DR-000001',exact:true})).toBeVisible();
    assert.deepEqual(commands.find(command=>command.path==='/api/sales/delivery-requests').body.requestedWindow,{date:'2028-10-10',start:'08:00',end:'10:00'});
  } finally {await context.close();}
});
test('timeslot frontend: malformed, empty and overnight times stay blocked; valid text formats predictably',async()=>{
  const {page,context}=await pageFor();
  try {
    await openNewForm(page);await page.getByLabel('Delivery address').fill('100 Test Road, Toronto');
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    const start=page.getByLabel('Start time',{exact:true}),end=page.getByLabel('End time',{exact:true});
    const submit=page.getByRole('button',{name:'Submit request',exact:true}),error=page.locator('[data-window-error]');
    await end.fill('2359');await end.press('Tab');await expect(end).toHaveValue('23:59');
    for(const value of ['8','08','800','0800','8:00',' 0800 ']) {
      await start.fill(value);await start.press('Tab');await expect(start).toHaveValue('08:00');await expect(submit).toBeEnabled();
    }
    for(const value of ['0860','2400','8:','noon','8:30 AM','12345']) {
      await start.fill(value);await start.press('Tab');await expect(start).toHaveValue(value);
      await expect(error).toContainText('valid 24-hour time');await expect(submit).toBeDisabled();
    }
    await start.fill('2200');await expect(error).toContainText('at least 2 hours');await expect(submit).toBeDisabled();
    await start.fill('2159');await expect(submit).toBeEnabled();
    await end.fill('0030');await expect(error).toContainText('at least 2 hours');await expect(submit).toBeDisabled();
    await end.fill('');await expect(submit).toBeDisabled();
    await end.fill('2359');await expect(submit).toBeEnabled();
    await start.fill('');await expect(submit).toBeDisabled();
  } finally {await context.close();}
});
for(const [audience,status,kind] of [['dispatch','submitted','propose'],['sales','preapproved','counter']]) {
  test(`timeslot frontend: ${kind} stays blocked through clock ticks and sends formatted times`,async()=>{
    row={...request(),quote,status,approvalExpiresAt:new Date(Date.now()+10800000).toISOString(),history:[]};
    const {page,context}=await pageFor(audience);
    try {
      await page.clock.install();await page.goto(`${base}/${audience}/delivery-requests?request=1`);
      const form=page.locator(`[data-form=${kind}]`),start=form.getByLabel('Start time',{exact:true}),end=form.getByLabel('End time',{exact:true});
      await start.fill('0800');await end.fill('0830');await end.press('Tab');
      await expect(start).toHaveValue('08:00');await expect(end).toHaveValue('08:30');
      await page.clock.runFor(1200);await expect(form.locator('button')).toBeDisabled();
      await expect(form.locator('[data-window-error]')).toBeVisible();
      await form.evaluate(element=>element.requestSubmit());
      assert.equal(commands.filter(command=>command.path.endsWith(`/actions/${kind}`)).length,0);
      await end.fill('1000');await expect(form.locator('button')).toBeEnabled();
      await form.locator('button').click();
      await expect.poll(()=>commands.filter(command=>command.path.endsWith(`/actions/${kind}`)).length).toBe(1);
      assert.deepEqual(commands.find(command=>command.path.endsWith(`/actions/${kind}`)).body.window,{date:slot().date,start:'08:00',end:'10:00'});
    } finally {await context.close();}
  });
}
test('timeslot frontend: correcting times cannot bypass quote recalculation or approval expiry',async()=>{
  const {page,context}=await pageFor();
  try {
    await page.clock.install();await openNewForm(page);
    await page.getByLabel('Delivery address').fill('100 Test Road');await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    await page.getByLabel('End time',{exact:true}).fill('0930');
    await page.getByLabel('Delivery address').fill('200 Changed Road');
    await page.getByLabel('End time',{exact:true}).fill('1100');
    await expect(page.getByRole('button',{name:'Submit request',exact:true})).toBeDisabled();
    row={...request(),quote,status:'preapproved',approvalExpiresAt:new Date(Date.now()+5000).toISOString(),history:[]};
    await page.goto(`${base}/sales/delivery-requests?request=1`);
    await page.clock.runFor(6000);
    const form=page.locator('[data-form=counter]');
    await form.getByLabel('Start time',{exact:true}).fill('0800');await form.getByLabel('End time',{exact:true}).fill('1000');
    await expect(form.locator('button')).toBeDisabled();
  } finally {await context.close();}
});
