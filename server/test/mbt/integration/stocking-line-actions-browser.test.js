import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const root=process.cwd(),out='test-artifacts/stocking-line-actions-20261006/browser';let browser,serial=0;
before(async()=>{mkdirSync(out,{recursive:true});browser=await chromium.launch({headless:true,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
async function fixture(audience='scm',purchase=true){
  const outputKey=++serial;
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.addInitScript(()=>{localStorage.setItem('mbbs.staff.token','line-test');localStorage.setItem('mbbs.scm.stockRequests.queue','request');
    localStorage.setItem('mbbs.sales.stockRequests.bucket','pending');window.EventSource=class extends EventTarget{close(){}};});
  const page=await context.newPage();page.setDefaultTimeout(7000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  const state={calls:[],errors:[],r:{id:1,requestRef:'REQ-LINES',requestType:'regular',workflowVersion:2,revision:1,requestedBy:'viewer',requestedByName:'Sales',status:'submitted',bucket:'pending',destinationLocationId:28,destinationName:'2967',
    regular:{deliveryMethod:'stocking',stockingType:purchase?'purchase':'transfer',approval:{automatic:false,lines:[]}},
    lines:[10,11,12,13].map(id=>({id,itemId:100+id,itemName:'Material '+id,itemDescription:'Line description',status:'submitted',salesQty:20,salesUom:'EA',toPcs:1,toPlt:100,pieces:20,sourceLocationId:1,sourceName:'3445',destinationLocationId:28,destinationName:'2967'})),events:[],transfers:[],availability:[]}};
  if(audience==='sales')state.r.events=[{id:1,eventType:'regular_scm_reply',requestLineId:12,actorName:'SCM',createdAt:'2026-10-06',details:{message:'Material C instructions',lineId:12}}];
  page.on('pageerror',error=>state.errors.push(error.message));
  await page.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname,method=route.request().method();
    if(path.startsWith('/api/')){
      const body=route.request().postDataJSON();state.calls.push({path,method,body});
      if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'viewer',display_name:'Viewer',role:audience,roles:[audience],yardLocationIds:[28]}}});
      if(path.endsWith('/alerts'))return route.fulfill({json:state.alerts||{requests:[],total:0,unread:0}});
      if(path===`/api/${audience}/stock-requests`)return route.fulfill({json:{requests:[state.r],yards:[{locationId:28,name:'2967'}],filterOptions:{vendors:[],sourceYards:[],destinationYards:[]}}});
      if(path===`/api/${audience}/stock-requests/1`)return route.fulfill({json:state.r});
      if(method==='POST'&&/\/(purchase-proposals|line-decisions|reply|resolve)$/.test(path)){
        const id=body.lineId??body.lines?.[0]?.lineId??body.lineIds?.[0],line=state.r.lines.find(row=>row.id===id);
        if(!line)return route.fulfill({status:400,json:{error:'Choose a material'}});
        state.r.revision++;state.r.status='active';
        if(path.endsWith('/purchase-proposals')){line.status='approved';line.purchase={demandId:1,approvedQuantity:100,reviewedQuantity:body.lines[0].reviewedSalesQty};}
        if(path.endsWith('/line-decisions')){line.status='rejected';line.decisionReason=body.reason;}
        if(path.endsWith('/reply')){line.reply={...body,audience};line.replyStatus=audience==='scm'?'pending_update':'pending_scm';
          state.r.events.unshift({id:state.r.revision,eventType:`regular_${audience}_reply`,requestLineId:id,actorName:'Viewer',createdAt:'2026-10-06',details:line.reply});}
        if(path.endsWith('/resolve')){line.status='closed';line.replyStatus=null;line.resolution={purchaseOrderRef:body.purchaseOrderRef,eta:body.eta};}
        return route.fulfill({json:state.r});
      }
      return route.fulfill({json:{requests:[],orders:[],revision:1,ordersByRole:{},enabled:true}});
    }
    const pathToFile=({'/sales/stock-requests':'/sales-stock-requests.html','/scm/stock-requests':'/scm-stock-requests.html'})[path]||path;
    const file=join(root,'public',pathToFile);if(!existsSync(file))return route.fulfill({status:404,body:''});
    return route.fulfill({body:readFileSync(file),contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript'});
  });
  await page.goto(`http://stocking.test/${audience}/stock-requests?tab=regular&requestId=1`);await expect(page.locator('.stock-request-detail')).toContainText('REQ-LINES');
  return {page,state,async close(){writeFileSync(`${out}/${audience}-${purchase}-${outputKey}.coverage.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
test('SCM Purchase actions send only the clicked material even when other materials are pending',async()=>{
  const f=await fixture();try{
    const {page,state}=f,card=id=>page.locator(`[data-scm-stock-line-id="${id}"]`);
    await expect(page.locator('[data-scm-stock-select-line]')).toHaveCount(0);
    await card(11).locator('[data-purchase-review-line]').fill('42');await card(11).locator('[data-scm-stock-action="purchase-add"]').click();
    await expect(card(11)).toContainText('Added to PO/TO proposal');
    const proposal=state.calls.find(call=>call.path.endsWith('/purchase-proposals'));assert.deepEqual(proposal.body.lines,[{lineId:11,reviewedSalesQty:42}]);
    assert.equal(state.r.lines[0].status,'submitted');
    await card(10).locator('[data-scm-stock-action="reject"]').click();await page.locator('[data-scm-stock-decision-reason]').fill('Reject this material only');
    await page.locator('[data-scm-stock-action="confirm-decision"]').click();await expect(card(10)).toContainText('Reject this material only');
    assert.deepEqual(state.calls.find(call=>call.path.endsWith('/line-decisions')).body.lineIds,[10]);
    await card(12).locator('[data-scm-stock-action="reply"]').click();await card(12).locator('[data-regular-reply-field="message"]').fill('Instructions C <script>literal</script>');
    await expect(card(13).locator('[data-regular-reply-form]')).toHaveCount(0);
    await card(12).locator('[data-regular-reply-form] button[type="submit"]').click();await expect(card(12)).toContainText('Instructions C <script>literal</script>');
    await expect(card(13)).not.toContainText('Instructions C');assert.equal(state.calls.find(call=>call.path.endsWith('/reply')).body.lineId,12);
    await card(13).locator('[data-scm-stock-action="resolve"]').click();await card(13).locator('[data-regular-resolution-field="purchaseOrderRef"]').fill('PO-D');
    await card(13).locator('[data-regular-resolution-field="eta"]').fill('2026-10-15');await card(13).locator('[data-regular-resolution-form] button[type="submit"]').click();
    await expect(card(13)).toContainText('PO-D');assert.equal(state.calls.find(call=>call.path.endsWith('/resolve')).body.lineId,13);
    assert.equal(state.r.lines[2].status,'submitted');assert.equal(state.r.status,'active');assert.deepEqual(state.errors,[]);
    await page.screenshot({path:out+'/purchase-lines.png',fullPage:true});
  }finally{await f.close();}
});
test('Transfer Stocking reply and Resolve controls belong to the individual material',async()=>{
  const f=await fixture('scm',false);try{
    const card=f.page.locator('[data-scm-stock-line-id="12"]');
    for(const action of ['reject','reply','resolve'])await expect(card.locator(`[data-scm-stock-action="${action}"]`)).toHaveAttribute('data-line-id','12');
    await card.locator('[data-scm-stock-action="reply"]').click();await card.locator('[data-regular-reply-field="message"]').fill('Transfer C only');
    await card.locator('[data-regular-reply-form] button[type="submit"]').click();assert.equal(f.state.calls.find(call=>call.path.endsWith('/reply')).body.lineId,12);
    await expect(f.page.locator('[data-scm-stock-line-id="10"]')).not.toContainText('Transfer C only');assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
test('Sales can reply only in the instructed material card and sends its line ID',async()=>{
  const f=await fixture('sales');try{
    const card=f.page.locator('[data-scm-stock-line-id="12"]');
    await expect(f.page.locator('[data-sales-stock-action="reply"]')).toHaveCount(1);
    await card.locator('[data-sales-stock-action="reply"]').click();await card.locator('[data-regular-reply-field="message"]').fill('Sales reply C');
    await card.locator('[data-regular-reply-field="salesOrderRef"]').fill('SO-C');await card.locator('[data-regular-reply-form] button[type="submit"]').click();
    const body=f.state.calls.find(call=>call.path.endsWith('/reply')).body;assert.equal(body.lineId,12);assert.equal(body.salesOrderRef,'SO-C');
    await expect(card).toContainText('Sales reply C');await expect(f.page.locator('[data-scm-stock-line-id="11"]')).not.toContainText('Sales reply C');assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
test('Sales resolution notification identifies the material and its PO/ETA',async()=>{
  const f=await fixture('sales');try{
    f.state.alerts={total:1,unread:1,requests:[{id:1,requestRef:'REQ-LINES',eventId:6,action:'resolve',lineId:12,itemName:'Material 12',purchaseOrderRef:'PO-C',eta:'2026-10-08'}]};
    await f.page.evaluate(()=>window.MBBSRegularStockAlert.refresh());
    await expect(f.page.locator('.regular-stock-popup')).toContainText('Stocking material resolved');
    await expect(f.page.locator('.regular-stock-popup')).toContainText('Material 12');
    await expect(f.page.locator('.regular-stock-popup')).toContainText('PO-C');await expect(f.page.locator('.regular-stock-popup')).toContainText('2026-10-08');
    assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
