import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {createSalesStockRequest,getScmStockRequest} from '../../../src/stock-request-repository.js';
import {regularStockAlerts,acknowledgeRegularStockDecisions} from '../../../src/regular-stock-request-service.js';
const out='test-artifacts/regular-stock-input-20261020';
let f,browser;const ids=[];
before(async()=>{
  mkdirSync(out,{recursive:true});f=await fixture({sku:88999661});
  await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,synced_at) VALUES(88999661,28,'2967',1000,1000,now()),(88999661,1,'3445',1000,1000,now())");
});
after(async()=>{
  await browser?.close();
  if(f){await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);await f.close();}
});
async function create({expired=false,status='approved',method='pickup',actor='sales',lines=1}={}){
  const yard=actor==='foreign'?28:1;
  const d=await createSalesStockRequest({destinationLocationId:yard,lines:Array.from({length:lines},()=>({itemId:88999661,sourceLocationId:yard===1?28:1,salesQty:2}))},{operatorId:f.users[actor].id,authorizedDestinationLocationIds:[yard]});ids.push(d.id);
  const regular={deliveryMethod:method,approvalExpiresAt:expired?'2000-01-01T00:00:00Z':'2099-01-01T00:00:00Z',approval:{automatic:true,leadTimeApplies:false,lines:[]}};
  await f.query('UPDATE sales_stock_requests SET workflow_version=2,regular_details=$2,status=$3 WHERE id=$1',[d.id,JSON.stringify(regular),['closed','received'].includes(status)?'completed':'active']);
  await f.query('UPDATE sales_stock_request_lines SET status=$2,regular_decision=$3 WHERE request_id=$1',[d.id,status,status==='approved'?'stock':null]);
  return getScmStockRequest(d.id);
}
const alerts=()=>regularStockAlerts({operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1]});
const close=d=>f.http('sales',`/api/sales/stock-requests/${d.id}/close-expired`,{expectedRevision:d.revision});
test('API combines selected statuses before pagination with existing yard access',async()=>{
  const a=await create(),b=await create({status:'closed'});await create({actor:'foreign'});
  const r=await f.http('sales','/api/sales/stock-requests?unifiedStatus=pending_sales,closed&limit=1');assert.equal(r.status,200);assert.equal(r.body.requests[0].id,b.id);
  const next=await f.http('sales','/api/sales/stock-requests?unifiedStatus=pending_sales,closed&limit=1&offset=1');assert.equal(next.status,200);assert.equal(next.body.requests[0].id,a.id);
});
test('Sales actions persist after viewing and acknowledgement, stay scoped, and clear after closure',async()=>{
  const d=await create({expired:true});const other=await create({actor:'foreign'});
  const event=(await f.query("INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details) VALUES($1,'regular_manual_decision',$2,'{}') RETURNING id",[d.id,f.users.scm.id])).rows[0];
  await f.query('UPDATE sales_stock_requests SET manual_decision_event_id=$2 WHERE id=$1',[d.id,event.id]);
  let a=await alerts();assert(a.actionRequired>0);assert(a.requests.some(r=>r.id===d.id&&r.action==='input_required'&&r.reason==='approval_expired'));assert(!a.requests.some(r=>r.id===other.id));
  await acknowledgeRegularStockDecisions(d.id,{eventId:Number(event.id)},{operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1]});
  a=await alerts();assert(a.requests.some(r=>r.id===d.id&&r.action==='input_required'));
  const closed=await close(d);assert.equal(closed.status,200,JSON.stringify(closed.body));assert.equal(closed.body.statusSummary.status,'closed');assert(!closed.body.statusSummary.needsAttention);
  assert(!(await alerts()).requests.some(r=>r.id===d.id));
});
test('Close expired is revision checked, audited, idempotent and excludes active or foreign work',async()=>{
  const d=await create({expired:true});const path=`/api/sales/stock-requests/${d.id}/close-expired`;
  assert.equal((await f.http('sales',path,{expectedRevision:d.revision+1})).status,409);
  assert.equal((await f.http('sales',path,{})).status,400);
  assert.equal((await f.http('foreign',path,{expectedRevision:d.revision})).status,403);
  const pair=await Promise.all([close(d),close(d)]);assert(pair.every(r=>r.status===200),JSON.stringify(pair));
  const events=(await f.query("SELECT * FROM sales_stock_request_events WHERE request_id=$1 AND event_type='regular_expired_closed'",[d.id])).rows;
  assert.equal(events.length,1);assert.equal(events[0].actor_id,f.users.sales.id);
  const final=await getScmStockRequest(d.id);assert(final.lines.every(l=>l.status==='closed'));assert.equal(final.revision,d.revision+1);
  for(const opts of [{},{expired:true,method:'stocking'},{expired:true,status:'received'}]){
    const active=await create(opts);assert.equal((await close(active)).status,409);assert.equal((await getScmStockRequest(active.id)).revision,active.revision);
  }
  const processing=await create({expired:true});
  await f.query("UPDATE sales_stock_requests SET regular_details=regular_details||'{\"handoffStatus\":\"executing\"}'::jsonb WHERE id=$1",[processing.id]);
  assert.equal((await close(processing)).status,409);
});
test('browser uses one multi-select Status, persists it, shows input alert and closes expired request',async()=>{
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const d=await create({expired:true}),context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users.sales.token);
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  try{
    await page.goto(f.base+`/sales/stock-requests?tab=regular&requestId=${d.id}`);
    await expect(page.locator('.regular-stock-popup[open] h2')).toHaveText('Stock request needs your input');
    for(let i=0;i<15&&await page.locator('.regular-stock-popup[open]').count();i++)await page.locator('.regular-stock-popup button').click();
    await expect(page.locator('[data-sales-stock-filter="backorderStageFilter"]')).toHaveCount(0);
    const menu=page.locator('[data-yard-filter="unifiedStatus"]');await expect(menu).toBeVisible();await menu.locator('summary').click();
    await page.locator('[data-sales-stock-filter="unifiedStatus"][value="pending_sales"]').check();
    await page.locator('[data-sales-stock-filter="unifiedStatus"][value="closed"]').check();
    await page.locator('[data-yard-filter-apply="unifiedStatus"]').click();
    await expect(menu).not.toHaveAttribute('open');
    await page.goto(f.base+'/sales/stock-requests?tab=regular');
    await menu.locator('summary').click();
    await expect(page.locator('[data-sales-stock-filter="unifiedStatus"][value="pending_sales"]')).toBeChecked();
    await expect(page.locator('[data-sales-stock-filter="unifiedStatus"][value="closed"]')).toBeChecked();
    await page.locator('[data-yard-filter-apply="unifiedStatus"]').click();
    // Dismiss informational popups; the action badge must remain.
    for(let i=0;i<15&&await page.locator('.regular-stock-popup[open]').count();i++)await page.locator('.regular-stock-popup button').click();
    await expect(page.locator('.regular-stock-alert[data-audience="sales"]')).toContainText('need your input');
    await page.locator(`.stock-request-card[data-id="${d.id}"]`).click();
    await expect(page.locator('[data-sales-stock-action="close-expired"]')).toBeVisible();
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-sales-stock-action="close-expired"]').click();
    await expect(page.locator(`.stock-request-card[data-id="${d.id}"] [data-regular-main-status]`)).toHaveText('Closed');
    await expect(page.locator('[data-sales-stock-action="close-expired"]')).toHaveCount(0);
    await page.setViewportSize({width:390,height:844});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:out+'/sales-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  }finally{
    const coverage=await page.coverage.stopJSCoverage();writeFileSync(out+'/browser-coverage.json',JSON.stringify(coverage));
    if(process.env.NODE_V8_COVERAGE)writeFileSync(process.env.NODE_V8_COVERAGE+'/sales-browser.json',JSON.stringify({result:coverage.filter(row=>row.url.startsWith(f.base)).map(row=>({...row,url:'file:///app/public'+new URL(row.url).pathname}))}));
    await context.close();
  }
});
test('SCM Status supports multiple choices, Clear and Apply on desktop and mobile',async()=>{
  browser ||= await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users.scm.token);
  page.on('pageerror',error=>errors.push(error.message));await page.coverage.startJSCoverage({resetOnNavigation:false});
  try{
    await page.goto(f.base+'/scm/stock-requests?tab=regular');
    const menu=page.locator('[data-yard-filter="unifiedStatus"]');await expect(menu).toBeVisible();
    await expect(menu.locator('input:checked')).toHaveCount(4);await menu.locator('summary').click();
    await menu.locator('[data-yard-filter-clear]').click();await expect(menu.locator('input:checked')).toHaveCount(0);
    if(!await menu.evaluate(el=>el.open))await menu.locator('summary').click();
    await menu.locator('[value="pending_sales"]').check();await menu.locator('[value="closed"]').check();
    await menu.locator('[data-yard-filter-apply]').click();await expect(menu).not.toHaveAttribute('open');
    await page.reload();await expect(menu.locator('input:checked')).toHaveCount(2);
    await page.evaluate(()=>window.MBBS_I18N.setLanguage('zh-CN'));
    await expect(menu.locator('summary')).toContainText('状态');
    await page.setViewportSize({width:390,height:844});await menu.locator('summary').click();
    await expect(menu.locator('[value="closed"]')).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:out+'/scm-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  }finally{
    const coverage=await page.coverage.stopJSCoverage();
    if(process.env.NODE_V8_COVERAGE)writeFileSync(process.env.NODE_V8_COVERAGE+'/scm-browser.json',JSON.stringify({result:coverage.filter(row=>row.url.startsWith(f.base)).map(row=>({...row,url:'file:///app/public'+new URL(row.url).pathname}))}));
    await context.close();
  }
});
test('Sales alerts include outstanding input beyond the first 100 requests',async()=>{
  const beforeCount=(await alerts()).actionRequired,created=[];
  for(let i=0;i<105;i++)created.push((await create()).id);
  const result=await alerts();assert.equal(result.actionRequired,beforeCount+105);
  for(const id of created)assert(result.requests.some(row=>row.id===id&&row.action==='input_required'));
});
