/* global window,document,localStorage */
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import {request,window as slot,sales,dispatcher} from '../support/delivery-request-fixtures.js';
let server,browser,base,row,calls,replyFailure,previewFailure,coverageIndex=0;
const quote={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',totalAmountMinor:23500,capacityPerTrip:26,trips:1,
  outbounds:[{originYardCode:'3445',rawDistanceMetres:20000,trips:1,totalAmountMinor:23500,rateCardName:'MBBS'}]};
const estimate={reference:'ESTB123',customerName:'Customer <img src=x onerror=alert(1)>',date:'2026-10-13',address:'100 Test Road',
  memo:'Keep quote prices',currency:'CAD',subtotal:60,tax:7.8,total:67.8,lines:[
    {description:'Gravel <script>bad</script>',quantity:2,unit:'Yard',rate:30,amount:60,pallets:1.25,layers:2,sections:0,pieces:8},
    {description:'Packing not entered',pallets:null,layers:null,sections:null,pieces:null},
    {description:'Explicit zero packing',pallets:0,layers:0,sections:0,pieces:0},
    {description:'Escaped packing text',pallets:'<img src=x onerror=alert(1)>',layers:null,sections:null,pieces:null}]};
function serveReply(req,res) {
  if(replyFailure){return res.status(503).json({error:'Could not send reply. Please retry.'});}
  if(req.body.expectedRevision!==row.revision){return res.status(409).json({error:'This request changed. Refresh before replying.'});}
  const message={revision:row.revision+1,action:'reply',actorName:req.params.audience==='sales'?'Sally':'Derek',
    audience:req.params.audience,message:req.body.message.trim(),createdAt:'2026-10-13T15:00:00Z'};
  row={...row,revision:row.revision+1,lastAction:'reply',conversation:[...row.conversation,message],history:[message,...row.history]};return res.json(row);
}
function servePreview(req,res) {
  if(previewFailure){return res.status(502).json({error:'Document unavailable. Please retry.'});}
  if(req.path.includes('/sales-orders/')){return res.type('application/pdf').send(Buffer.from('%PDF-1.4 original'));}
  if(req.path.includes('/transfer-orders/')) {return res.json({reference:'TO123',date:'2026-10-15',fromYard:'3445',toYard:'2967',
    address:'Receiving yard',memo:'Call before unloading',lines:estimate.lines});}
  return res.json(estimate);
}
before(async()=>{
  const app=express();app.use(express.json());
  app.get('/api/auth/me',(req,res)=>res.json({operator:req.headers.authorization?.includes('dispatch-token')?dispatcher:sales}));
  app.get('/api/events',(_req,res)=>res.status(204).end());
  app.use('/api/:audience/delivery-requests',(req,res)=>{
    calls.push({audience:req.params.audience,path:req.path,method:req.method,body:req.body});
    if(req.path==='/meta'){return res.json({requestingYards:[{id:1,code:'3445'}],outboundYards:['3445','2967','12441','150'],
      binTypes:[{code:'14YD',name:'14 Yard',nominalYards:14}],aggregates:['Gravel','HPE','Screening','Crusher Run'],settings:{pos:26,bin:1,approvalHours:3,reminderHours:1,revision:1}});}
    if(req.path==='/alerts'){return res.json({count:0,requests:[]});}
    if(req.path.includes('/preview')) {
      return servePreview(req,res);
    }
    if(req.path==='/quotes'){return res.status(201).json({...quote,pricing:req.body});}
    if(req.path.endsWith('/read')){return res.json({readRevision:req.body.revision});}
    if(req.path==='/') {
      if(req.method==='POST'){row={...request(),...req.body,quote,estimateRef:String(req.body.estimateRef || '').trim().toUpperCase(),history:[],conversation:[]};return res.status(201).json(row);}
      return res.json({requests:row?[row]:[]});
    }
    if(req.path==='/1'){return res.json(row);}
    if(req.path.endsWith('/actions/secure') || req.path.endsWith('/actions/relink')) {
      row={...row,status:'confirmed',revision:row.revision+1,salesOrderRefs:req.body.salesOrderRefs,approvalExpiresAt:null};return res.json(row);
    }
    if(req.path.endsWith('/actions/reply')) {
      return serveReply(req,res);
    }
    return res.status(404).json({error:'Not found'});
  });
  app.get(['/api/sales/delivery-instructions/orders/:ref','/api/dispatch/orders/:ref/delivery-instructions'],(_req,res)=>
    res.json({orderId:91,orderRef:'SO123',revision:0,additionalText:'',automatic:{text:'Call before arrival'},media:[],editable:true}));
  const publicRoot=new URL('../../../public/',import.meta.url).pathname;
  app.get(['/sales/delivery-requests','/dispatch/delivery-requests'],(_req,res)=>res.sendFile(publicRoot+'delivery-requests.html'));
  app.use(express.static(publicRoot));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
test('TO links: Sales secures a transfer-only request then adds an SO without sending TOs to Sales Order instruction APIs',async()=>{
  row={...request(),quote,status:'preapproved',confirmedWindow:slot(),approvalExpiresAt:new Date(Date.now()+10800000).toISOString(),history:[],conversation:[]};
  const {page,context}=await pageFor('sales',390),instructionCalls=[];
  page.on('request',request=>{if(request.url().includes('/delivery-instructions')) {instructionCalls.push(request.url());}});
  try {
    const input=page.locator('[data-form=secure] input[name=salesOrderRefs]');await expect(input).toHaveAttribute('placeholder','SO123 or TO123');
    await input.fill('to123');await page.getByRole('button',{name:'Secure approval',exact:true}).click();
    await expect(page.locator('[data-approval-clock]')).toContainText('Secured · TO123');
    assert.deepEqual(row.salesOrderRefs,['TO123']);await expect(page.locator('[data-linked-order]')).toHaveCount(0);
    await expect(page.locator('[data-notice]')).not.toContainText('not found');assert.deepEqual(instructionCalls,[]);
    await page.getByRole('button',{name:'Add order',exact:true}).click();
    await page.locator('[data-form=relink] input[name=salesOrderRefs]').nth(1).fill('SO123');
    await page.getByRole('button',{name:'Save order links',exact:true}).click();
    await expect(page.locator('[data-linked-order]')).toHaveValue('SO123');
    await expect(page.locator('[data-linked-order] option')).toHaveText(['SO123']);
    await expect(page.locator('[data-instructions]')).toContainText('Call before arrival');
    assert.ok(instructionCalls.length>0);assert.ok(instructionCalls.every(url=>url.includes('/SO123')));
    assert.equal(row.confirmedWindow.start,'09:00');assert.deepEqual(row.salesOrderRefs,['TO123','SO123']);
    await page.getByRole('button',{name:'Unlink SO123',exact:true}).click();await page.getByRole('button',{name:'Save order links',exact:true}).click();
    await expect(page.locator('[data-linked-order]')).toHaveCount(0);await expect(page.getByRole('button',{name:'Unlink TO123',exact:true})).toBeDisabled();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
    await page.screenshot({path:'test-artifacts/delivery-requests-ui/transfer-link-sales-mobile.png',fullPage:true});
  } finally {await context.close();}
});
test('TO preview: both teams see transfer identity and quantity-only lines on desktop and mobile',async()=>{
  for(const [audience,width] of [['sales',1440],['dispatch',390]]) {
    row={...request(),quote,status:'confirmed',confirmedWindow:slot(),salesOrderRefs:['TO123'],history:[],conversation:[]};
    const {page,context}=await pageFor(audience,width);
    try {
      await page.getByRole('button',{name:'Preview TO123',exact:true}).click();const modal=page.getByRole('dialog');
      await expect(modal.getByRole('heading',{name:'Transfer Order preview · TO123',exact:true})).toBeVisible();
      await expect(modal).toContainText('3445 → 2967');await expect(modal).toContainText('Call before unloading');
      await expect(modal.locator('th')).toHaveText(['Description','Quantity','PLT','LYR','SEC','PCS']);
      await expect(modal).not.toContainText('$');await expect(modal.locator('script,img,iframe')).toHaveCount(0);
      assert.ok(calls.some(call=>call.path==='/1/transfer-orders/TO123/preview'));
      await page.screenshot({path:`test-artifacts/delivery-requests-ui/transfer-preview-${audience}-${width}.png`,fullPage:true});
      await page.keyboard.press('Escape');await expect(modal).toHaveCount(0);
      if(audience==='dispatch') {await expect(page.locator('[data-form=relink]')).toHaveCount(0);}
    } finally {await context.close();}
  }
});
beforeEach(()=>{row=null;calls=[];replyFailure=false;previewFailure=false;});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server){await new Promise(resolve=>server.close(resolve));}});
async function pageFor(audience='sales',width=1100) {
  const context=await browser.newContext({viewport:{width,height:850},serviceWorkers:'block'});
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),`${audience}-token`);
  const page=await context.newPage();page.setDefaultTimeout(5000);
  if(process.env.DELIVERY_UI_COVERAGE==='1') {
    await page.coverage.startJSCoverage();const close=context.close.bind(context);
    context.close=async()=>{try{await fs.writeFile(`test-artifacts/delivery-requests-ui/enhancement-coverage-${++coverageIndex}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));}finally{await close();}};
  }
  await page.goto(`${base}/${audience}/delivery-requests${row?'?request=1':''}`);
  return {page,context};
}
test('conversation follows Remarks, displays both teams and sends replies without changing secured delivery',async()=>{
  for(const audience of ['sales','dispatch']) {
    row={...request(),quote,status:'confirmed',confirmedWindow:slot(),salesOrderRefs:['SO123'],estimateRef:'ESTB123',history:[],
      conversation:[{revision:2,audience:'dispatch',actorName:'Derek',message:'Can we deliver tomorrow?',action:'propose',createdAt:'2026-10-13T14:00:00Z'},
        {revision:3,audience:'sales',actorName:'Sally',message:'Customer prefers today.',action:'counter',createdAt:'2026-10-13T14:10:00Z'}]};
    const {page,context}=await pageFor(audience,390);
    try {
      const board=page.locator('[data-conversation]');await expect(board).toBeVisible();
      assert.ok(await board.evaluate(node=>node.previousElementSibling?.querySelector('dt:last-of-type')?.textContent==='Remarks'));
      await expect(board).toContainText('Dispatch · Derek');await expect(board).toContainText('Sales · Sally');
      const stable=JSON.stringify({status:row.status,quote:row.quote,confirmedWindow:row.confirmedWindow,salesOrderRefs:row.salesOrderRefs});
      await page.locator('[data-form=reply] textarea').fill('Please call first. <img src=x>');
      await page.getByRole('button',{name:'Send reply',exact:true}).click();
      await expect(board).toContainText('Please call first. <img src=x>');await expect(board.locator('img')).toHaveCount(0);
      assert.equal(JSON.stringify({status:row.status,quote:row.quote,confirmedWindow:row.confirmedWindow,salesOrderRefs:row.salesOrderRefs}),stable);
      assert.equal(calls.filter(call=>call.method==='POST' && call.path.includes('/actions/')).at(-1).path,'/1/actions/reply');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
      await page.screenshot({path:`test-artifacts/delivery-requests-ui/conversation-${audience}.png`,fullPage:true});
    } finally {await context.close();}
  }
});
test('failed replies retain text and a retry uses the same operation ID',async()=>{
  row={...request(),quote,history:[],conversation:[]};const {page,context}=await pageFor();
  try {
    const reply=page.locator('[data-form=reply] textarea');await reply.fill('Keep my message');replyFailure=true;
    await page.getByRole('button',{name:'Send reply',exact:true}).click();await expect(page.locator('[data-notice]')).toContainText('Could not send reply');
    await expect(reply).toHaveValue('Keep my message');replyFailure=false;
    await page.getByRole('button',{name:'Send reply',exact:true}).click();await expect(page.locator('[data-conversation]')).toContainText('Keep my message');
    const sends=calls.filter(call=>call.path.endsWith('/actions/reply'));assert.equal(sends.length,2);assert.equal(sends[0].body.operationId,sends[1].body.operationId);
  } finally {await context.close();}
});
test('both conversation boards exclude system and staff updates while request history retains them',async()=>{
  const system={revision:4,audience:'system',actorName:'System',message:'Approval expired. Re-raise for Dispatch approval.',action:'expire',createdAt:'2026-10-13T14:20:00Z'};
  const staff={...system,revision:5,audience:'staff',actorName:'Staff',message:'Delivery instructions updated for SO123.',action:'instructions'};
  const human={...system,revision:3,audience:'sales',actorName:'Sally',message:'Please discuss the system update with the customer.',action:'reply'};
  for(const audience of ['sales','dispatch']) {
    row={...request(),quote,history:[staff,system,human],conversation:[human,system,staff,{...human,actorName:'Blank author',message:'   '}]};
    const {page,context}=await pageFor(audience);
    try {
      const board=page.locator('[data-conversation]');
      await expect(board).toContainText(human.message);
      await expect(board).not.toContainText(system.message);await expect(board).not.toContainText(staff.message);
      await expect(board).not.toContainText('Blank author');
      await expect(board.locator('.dr-message')).toHaveCount(1);
      await page.getByText('Request history',{exact:true}).click();
      await expect(page.locator('.dr-history')).toContainText(system.message);
      await expect(page.locator('.dr-history')).toContainText(staff.message);
    } finally {await context.close();}
    row={...request(),quote,history:[system,staff]};
    const empty=await pageFor(audience);
    try {
      await expect(empty.page.locator('[data-conversation]')).toContainText('No messages yet.');
      await expect(empty.page.locator('[data-conversation] .dr-message')).toHaveCount(0);
    } finally {await empty.context.close();}
  }
});
test('POS uses two whole pallet fields and BIN uses an aggregate dropdown and Yard quantities',async()=>{
  const {page,context}=await pageFor();
  try {
    await page.getByRole('button',{name:'New request',exact:true}).click();
    await page.getByLabel('Full POS qty',{exact:true}).fill('25');await page.getByLabel('Loose POS qty',{exact:true}).fill('2');
    await page.getByLabel('Delivery address').fill('100 Test Road');await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    const pos=calls.filter(call=>call.path==='/quotes').at(-1).body;assert.equal(pos.totalUnits,27);
    assert.deepEqual(pos.outbounds,[{originYardCode:'3445',fullPosQty:25,loosePosQty:2,totalUnits:27}]);
    await page.getByLabel('Load type').selectOption('bin');
    await expect(page.getByLabel('Aggregate',{exact:true})).toBeVisible();
    assert.deepEqual(await page.getByLabel('Aggregate',{exact:true}).locator('option').allTextContents(),['Choose aggregate','Gravel','HPE','Screening','Crusher Run']);
    await page.getByLabel('Aggregate',{exact:true}).selectOption('Crusher Run');await page.getByLabel('Quantity (Yard)',{exact:true}).fill('14.01');
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();
    const bin=calls.filter(call=>call.path==='/quotes').at(-1).body;assert.equal(bin.quantityUnit,'yard');assert.equal(bin.aggregate,'Crusher Run');assert.equal(bin.totalUnits,14.01);
    await expect(page.getByLabel('Full POS qty',{exact:true})).toHaveCount(0);
    await page.screenshot({path:'test-artifacts/delivery-requests-ui/bin-yard-request.png',fullPage:true});
  } finally {await context.close();}
});
test('EST preview works before submission, escapes content and preserves the form when closed',async()=>{
  const {page,context}=await pageFor();
  try {
    await page.getByRole('button',{name:'New request',exact:true}).click();
    await page.getByLabel('Quote (EST) number',{exact:true}).fill('ESTB123');await page.getByLabel('Customer (optional)').fill('Unsaved customer');
    await page.getByRole('button',{name:'Preview quote',exact:true}).click();
    const modal=page.getByRole('dialog');await expect(modal).toContainText('ESTB123');await expect(modal).toContainText('Gravel <script>bad</script>');
    await expect(modal.locator('th')).toHaveText(['Description','Quantity','PLT','LYR','SEC','PCS']);
    await expect(modal).not.toContainText('67.80');await expect(modal.locator('script,img')).toHaveCount(0);
    await modal.getByRole('button',{name:'Close preview',exact:true}).click();await expect(modal).toHaveCount(0);
    await expect(page.getByLabel('Customer (optional)')).toHaveValue('Unsaved customer');
    await page.getByLabel('Delivery address').fill('100 Test Road');await page.getByLabel('Requested date').fill('2028-10-10');
    await page.getByRole('button',{name:'Calculate charge',exact:true}).click();await page.getByRole('button',{name:'Submit request',exact:true}).click();
    await expect(page.getByRole('heading',{name:'DR-000001',exact:true})).toBeVisible();assert.equal(row.estimateRef,'ESTB123');
    await page.getByRole('button',{name:'Preview quote ESTB123',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Customer');
    await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {await context.close();}
});
test('both teams preview saved SOs and document errors appear inside an accessible closable dialog',async()=>{
  for(const audience of ['sales','dispatch']) {
    row={...request(),quote,status:'confirmed',confirmedWindow:slot(),salesOrderRefs:['SO123'],history:[],conversation:[]};
    const {page,context}=await pageFor(audience);
    try {
      await page.getByRole('button',{name:'Preview SO123',exact:true}).click();
      await expect(page.getByRole('dialog').locator('iframe')).toHaveAttribute('src',/^blob:/);
      await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
      previewFailure=true;await page.getByRole('button',{name:'Preview SO123',exact:true}).click();
      await expect(page.getByRole('dialog')).toContainText('Document unavailable');
      await page.getByRole('dialog').getByRole('button',{name:'Close preview',exact:true}).click();
      await expect(page.getByRole('button',{name:'Preview SO123',exact:true})).toBeFocused();
      previewFailure=false;
    } finally {await context.close();}
  }
});
test('both teams see original PLT LYR SEC PCS quote values with blanks, zeroes and contained mobile scrolling',async()=>{
  for(const [audience,width] of [['sales',1440],['dispatch',1440],['sales',390],['dispatch',390]]) {
    row={...request(),quote,estimateRef:'ESTB123',history:[],conversation:[]};
    const {page,context}=await pageFor(audience,width);
    try {
      await page.getByRole('button',{name:'Preview quote ESTB123',exact:true}).click();
      const modal=page.getByRole('dialog'),table=modal.locator('.dr-preview-table');
      await expect(table.locator('th')).toHaveText(['Description','Quantity','PLT','LYR','SEC','PCS']);
      await expect(table.locator('tbody tr').nth(0).locator('td')).toHaveText([
        'Gravel <script>bad</script>','2 Yard','1.25','2','0','8']);
      await expect(modal).not.toContainText('$');await expect(modal).not.toContainText('67.80');
      await expect(table.locator('tbody tr').nth(1).locator('td').filter({hasText:'—'})).toHaveCount(4);
      await expect(table.locator('tbody tr').nth(2).locator('td').filter({hasText:/^0$/})).toHaveCount(4);
      await expect(table.locator('tbody tr').nth(3).locator('td').nth(2)).toHaveText('<img src=x onerror=alert(1)>');
      await expect(modal.locator('img,script')).toHaveCount(0);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
      if(width===390) {assert.ok(await table.evaluate(node=>node.scrollWidth>node.clientWidth));}
      await page.screenshot({path:`test-artifacts/delivery-requests-ui/quote-packing-${audience}-${width}.png`,fullPage:true});
      await page.keyboard.press('Escape');await expect(modal).toHaveCount(0);
      await expect(page.getByRole('button',{name:'Preview quote ESTB123',exact:true})).toBeFocused();
    } finally {await context.close();}
  }
});
