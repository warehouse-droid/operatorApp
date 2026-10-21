import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {createSpecialStockCase} from '../../../src/special-stock-request-repository.js';

let f,browser;const specials=[],out='test-artifacts/stock-check-popup';
before(async()=>{mkdirSync(out,{recursive:true});f=await fixture({sku:88999529});browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});});
after(async()=>{await browser?.close();if(f){try{await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[specials]);}finally{await f.close();}}});
async function pageFor(role,id){
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users[role].token);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.goto(f.base+'/sales/stock-requests?tab=regular'+(id?'&requestId='+id:''));
  await expect(page.locator('[data-sales-multi-filter="backorderStageFilter"] summary')).toBeVisible();
  await page.evaluate(()=>window.MBBSRegularStockAlert.refresh());
  return {page,context,errors};
}
test('A live SCM stock check opens a popup on the selected request, preserves unsaved text, and notifies once including completion',async()=>{
  let d=await f.create(1);const ui=await pageFor('sales',d.id),other=await pageFor('foreign');
  const popup=ui.page.locator('dialog.regular-stock-popup');
  try{
    const p=ui.page;await expect(p.locator('[data-backorder-detail]')).toHaveAttribute('data-backorder-id',String(d.id));
    await p.getByText('Edit request header',{exact:true}).click();
    const draft=p.locator('[data-backorder-form][data-action="header"] [name="remarks"]');await draft.fill('TEST unsaved Sales note');
    await p.evaluate(()=>{window.beforeStockCheck=document.querySelector('.stock-request-list');});
    d=await f.review(d);
    await expect(popup).toBeVisible();await expect(popup).toContainText('SCM updated the stock check');await expect(popup).toContainText('In stock');await expect(popup).toContainText(d.requestRef);
    await expect(draft).toHaveValue('TEST unsaved Sales note');
    assert.equal(await p.evaluate(()=>window.beforeStockCheck===document.querySelector('.stock-request-list')),true);
    await expect(other.page.locator('dialog.regular-stock-popup')).toHaveCount(0);
    await p.screenshot({path:out+'/open-request-stock-check.png',fullPage:true});
    await popup.getByRole('button',{name:'Close',exact:true}).click();await p.evaluate(()=>window.MBBSRegularStockAlert.refresh());await expect(popup).toHaveCount(0);
    d=await f.ordered(d);
    await expect(popup).toContainText('Already Ordered · Completed');await expect(popup).toContainText('PO-UNSYNCED-'+d.id);
    await popup.getByRole('link',{name:'Open request',exact:true}).click();
    await expect(p.locator('[data-backorder-detail]')).toContainText('Completed');await expect(popup).toHaveCount(0);
    await p.reload();await p.evaluate(()=>window.MBBSRegularStockAlert.refresh());await expect(popup).toHaveCount(0);
    assert.deepEqual(ui.errors,[]);assert.deepEqual(other.errors,[]);
  }finally{await ui.context.close();await other.context.close();}
});
test('Special stock checks notify the requester with Sales-visible notes and a link to the matching request',async()=>{
  const d=await createSpecialStockCase({storeLocationId:1,fulfillmentMethod:'yard_pickup',customerName:'TEST popup customer',vendorName:'TEST vendor',
    inquiryDate:'2098-02-01',lines:[{productName:'TEST special material',quantity:2,uom:'EACH',rate:10,requiredDate:'2098-02-10'}]},
    {operatorId:f.users.sales.id,authorizedStoreLocationIds:[1]});specials.push(d.id);
  const ui=await pageFor('sales'),popup=ui.page.locator('dialog.regular-stock-popup');
  try{
    const result=await f.http('scm',`/api/scm/special-stock-requests/${d.id}/lines/${d.lines[0].id}/response`,
      {expectedRevision:d.revision,supplyStatus:'low_inventory',availabilityMode:'dated',availableDate:'2098-02-05',vendorId:331,vendorName:'TEST vendor',vendorYard:'TEST yard',salesVisibleNote:'TEST public note',scmInternalNote:'PRIVATE COST NOTE'});
    assert.equal(result.status,200,JSON.stringify(result.body));
    await expect(popup).toContainText('Low inventory');await expect(popup).toContainText('TEST public note');await expect(popup).not.toContainText('PRIVATE COST NOTE');
    await expect(popup.getByRole('link',{name:'Open request',exact:true})).toHaveAttribute('href',`/sales/stock-requests?tab=special&search=${encodeURIComponent(d.requestRef)}`);
    await ui.page.setViewportSize({width:390,height:844});await ui.page.screenshot({path:out+'/special-stock-check-mobile.png',fullPage:true});
    await popup.getByRole('link',{name:'Open request',exact:true}).click();await expect(ui.page.locator('.stock-request-detail')).toContainText(d.requestRef);
    assert.deepEqual(ui.errors,[]);
    writeFileSync(out+'/result.json',JSON.stringify({regular:true,special:true,recipientScope:true,draftsRetained:true,completion:true,deduplicated:true},null,2));
  }finally{await ui.context.close();}
});
