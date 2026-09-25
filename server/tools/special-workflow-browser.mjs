import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const output='test-artifacts/special-workflow-review';
const base='http://127.0.0.1:3000';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const contexts=[],pages={},records=[];
async function login(role) {
  const context=await browser.newContext({viewport:{width:1440,height:1000}}); contexts.push([role,context]);
  await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  const page=await context.newPage(); pages[role]=page;
  page.on('pageerror',error=>console.log('PAGE ERROR',role,error.message));
  await page.goto(`${base}/${role}/stock-requests`);
  await page.locator('[name=username]').fill(`review-${role}`);
  await page.locator('[name=password]').fill('SpecialReview-2026!');
  await page.locator('[data-form=dispatch-login] button[type=submit]').click();
  await page.locator(role === 'scm' ? '[data-stock-request-tab= special]' : '[data-sales-stock-action=special]').click();
  await page.getByRole('heading',{name:'Special Stock Requests',exact:true}).waitFor();
  await page.screenshot({path:`${output}/${role}-initial.png`,fullPage:true});
  console.log(role,'ready');
  return page;
}

async function action(page, form, path, button='button[type=submit]') {
  const responsePromise=page.waitForResponse(response=>response.url().endsWith(path) && ['POST','PUT'].includes(response.request().method()),{timeout:15000});
  await form.locator(button).click();
  const response=await responsePromise;
  const body=await response.json();
  assert.ok(response.ok(), `${path}: ${JSON.stringify(body)}`);
  return body;
}
async function select(role, id) {
  const page=pages[role];
  await page.locator(`[data-special-${role==='sales'?'sales':'scm'}-action=refresh]`).click();
  const card=page.locator(`[data-special-${role==='sales'?'sales':'scm'}-action=select][data-id="${id}"]`);
  await card.waitFor();
  const response=page.waitForResponse(response=>response.url().endsWith(`/special-stock-requests/${id}`));
  await card.click(); await response;
  await page.locator('.stock-request-detail h2').waitFor();
}
async function createCase(target, method, count=1) {
  const page=pages.sales;
  await page.locator('[data-special-sales-action=new]').click();
  let form=page.locator('[data-special-case-form]');
  await form.locator('[name=customerName]').fill('TEST Review');
  await page.locator('[data-special-sales-action=choose-case-customer][data-customer-id="8899100"]').click();
  await form.locator('[name=vendorName]').fill('TEST Review');
  await page.locator('[data-special-sales-action=choose-case-vendor][data-vendor-id="8899200"]').click();
  await form.locator('[name=remarks]').fill(`TEST REVIEW — ${target}. Simulated NetSuite; created entirely through frontend.`);
  await form.locator('[name=fulfillmentMethod]').selectOption(method);
  if(method==='mbt_delivery') {
    await form.locator('[name=deliveryAddress]').fill('TEST ONLY — 123 Example Street, Toronto ON');
    await form.locator('[name=deliveryContactName]').fill('TEST Customer Contact');
    await form.locator('[name=deliveryContactPhone]').fill('416-555-0100');
  }
  for(let i=0;i<count;i++) {
    if(i) await page.locator('[data-special-sales-action=add-case-line]').click();
    const line=form.locator(`[data-special-composer-line="${i}"]`);
    await line.locator('[name=productName]').fill(`TEST ${target} product ${i+1}`);
    await line.locator('[name=quantity]').fill('2');
  }
  return action(page,form,'/api/sales/special-stock-requests');
}
async function respond(detail,index,status='in_stock',eta='') {
  await select('scm',detail.id); const page=pages.scm;
  const form=page.locator(`[data-special-response-form][data-line-id="${detail.lines[index].id}"]`);
  await form.locator('[name=supplyStatus]').selectOption(status);
  await form.locator('[name=availableDate]').fill(eta);
  await form.locator('[name=vendorYard]').fill('TEST Vendor Yard — 456 Example Road, Toronto ON');
  await form.locator('[name=unitPurchaseCost]').fill('4.25');
  await form.locator('[name=salesVisibleNote]').fill(status==='in_stock'?'TEST stock checked and available':eta?'TEST estimated supply date':'TEST vendor has no stock and no ETA');
  return action(page,form,`/api/scm/special-stock-requests/${detail.id}/lines/${detail.lines[index].id}/response`);
}
async function accept(detail) {
  await select('sales',detail.id); const page=pages.sales;
  for(const line of detail.lines.filter(line=>line.salesDecision!=='accepted')) {
    const form=page.locator(`[data-special-decision-form][data-line-id="${line.id}"]`);
    await form.locator('[name=decision]').selectOption('accepted');
    detail=await action(page,form,`/api/sales/special-stock-requests/${detail.id}/lines/${line.id}/decision`);
  }
  return detail;
}
async function salesOrder(detail,pallets=0) {
  await select('sales',detail.id); const page=pages.sales, form=page.locator('[data-special-so-form]');
  for(let i=0;i<detail.lines.length;i++) {
    const line=form.locator(`[data-special-material="${detail.lines[i].id}"]`);
    await line.locator('[name=quantity]').fill(String(100*(i+1)));
    await line.locator('[name=uom]').selectOption('PC');
    await line.locator('[name=rate]').fill('9.50');
  }
  await form.locator('[name=palletTotal]').fill(String(pallets));
  if(pallets) await form.locator('[name=palletRate]').fill('35');
  detail=await action(page,form,`/api/sales/special-stock-requests/${detail.id}/sales-order-draft`);
  const response=page.waitForResponse(r=>r.url().endsWith(`/special-stock-requests/${detail.id}/sales-order/create`));
  await page.locator('[data-special-sales-action=create-so]').click();
  const result=await response, body=await result.json(); assert.ok(result.ok(),JSON.stringify(body));
  assert.equal(body.salesOrderLines.filter(line=>line.itemId===1784).length,pallets?1:0);
  return body;
}
async function purchaseOrder(detail,edit=false) {
  await select('scm',detail.id); const page=pages.scm, form=page.locator('[data-special-po-form]');
  if(edit) await form.locator('[name=description]').first().fill('TEST SCM revised description — synchronized to SO');
  const updated=await action(page,form,`/api/scm/special-stock-requests/${detail.id}/purchase-order/create`);
  if(edit) assert.equal(updated.salesOrderLines[0].description,'TEST SCM revised description — synchronized to SO');
  return updated;
}
async function persist(target,detail) {
  assert.equal(detail.stage,target);
  const i=records.findIndex(record=>record.target===target);
  const record={target,id:detail.id,requestRef:detail.requestRef,stage:detail.stage,salesOrderRef:detail.salesOrderRef,purchaseOrderRef:detail.purchaseOrderRef,palletTotal:detail.palletTotal,readinessAlerts:detail.readinessAlerts};
  if(i>=0) records[i]=record; else records.push(record);
  await fs.writeFile(`${output}/records.json`,JSON.stringify(records,null,2));
  await select('sales',detail.id); await pages.sales.screenshot({path:`${output}/${target}-sales.png`,fullPage:true});
  await select('scm',detail.id); await pages.scm.screenshot({path:`${output}/${target}-scm.png`,fullPage:true});
  console.log('STOPPED',target,detail.requestRef);
}
try {
  await login('sales'); await login('scm');
  let existing=[];
  try { existing=JSON.parse(await fs.readFile(`${output}/records.json`,'utf8')); records.push(...existing); } catch {}
  // Resume unfinished browser-created cases by reading the actual API only.
  const all=await pages.sales.evaluate(async()=> (await (await fetch('/api/sales/special-stock-requests?limit=150')).json()).requests);
  for(const [target,method,count,pallets] of [
    ['new_enquiry','vendor_pickup',1,0],['await_customer_confirmation','mbt_delivery',1,0],
    ['confirmed','yard_pickup',1,3],['dispatch_arrangement','mbt_delivery',1,0],
    ['wait_for_production','mbt_delivery',2,2],['closed','vendor_pickup',1,0],['completed','vendor_pickup',1,0]
  ]) {
    if(existing.some(record=>record.target===target)) continue;
    let detail=all.find(record=>record.remarks.startsWith(`TEST REVIEW — ${target}.`));
    if(!detail) detail=await createCase(target,method,count);
    if(target==='new_enquiry') { await persist(target,detail); continue; }
    for(let i=0;i<count;i++) if(!detail.lines[i].supplyStatus) {
      detail=await respond(detail,i,target==='closed'?'no_stock':target==='wait_for_production'&&i===1?'production':'in_stock',target==='wait_for_production'&&i===1?'2026-09-25':'');
    }
    if(target==='await_customer_confirmation') { await persist(target,detail); continue; }
    if(target==='closed') {
      await select('scm',detail.id); const form=pages.scm.locator('[data-special-scm-close-form]');
      await form.locator('[name=reason]').fill('TEST vendor cannot provide stock or any ETA');
      detail=await action(pages.scm,form,`/api/scm/special-stock-requests/${detail.id}/close-unavailable`);
      await persist(target,detail); continue;
    }
    if(!detail.salesOrderId) { detail=await accept(detail); detail=await salesOrder(detail,pallets); }
    if(target==='confirmed') { await persist(target,detail); continue; }
    if(!detail.purchaseOrderId) detail=await purchaseOrder(detail,target==='dispatch_arrangement');
    if(target==='wait_for_production') {
      await select('scm',detail.id); const form=pages.scm.locator(`[data-special-readiness-form][data-line-id="${detail.lines[1].id}"]`);
      await form.locator('[name=ready]').selectOption('false');
      await form.locator('[name=eta]').fill('2099-10-01');
      detail=await action(pages.scm,form,`/api/scm/special-stock-requests/${detail.id}/lines/${detail.lines[1].id}/readiness`);
      assert.equal(detail.readinessAlerts.length,1);
      assert.equal(detail.handoff,null);
    }
    if(target==='completed') {
      await select('sales',detail.id); const form=pages.sales.locator('[data-special-vendor-pickup-form]');
      await form.locator('[name=pickupReference]').fill('TEST collection confirmed by customer — review evidence only');
      detail=await action(pages.sales,form,`/api/sales/special-stock-requests/${detail.id}/vendor-pickup/complete`);
    }
    await persist(target,detail);
  }
} catch(error) {
  for(const [role,page] of Object.entries(pages)) {
    await page.screenshot({path:`${output}/failure-${role}.png`,fullPage:true}).catch(()=>{});
    await fs.writeFile(`${output}/failure-${role}.txt`,await page.locator('body').innerText()).catch(()=>{});
  }
  throw error;
} finally {
  for(const [role,context] of contexts) await context.tracing.stop({path:`${output}/${role}-trace.zip`});
  await browser.close();
}
