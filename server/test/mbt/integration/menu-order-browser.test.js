import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {createOperator,loginOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';

let server,browser,base,admin,sales;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for(const role of ['admin','sales']) {
    const username=`menu-browser-${role}-${crypto.randomUUID()}`,password=crypto.randomUUID();
    await createOperator({username,password,displayName:'Menu browser',role,yardLocationIds:[1]});
    const account=await loginOperator(username,password);
    if(role==='admin') {admin=account;} else {sales=account;}
  }
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
beforeEach(async()=>{await query("UPDATE app_menu_order_settings SET orders='{}',revision=revision+1 WHERE id=true");});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server) {await new Promise(resolve=>server.close(resolve));}await closeDb();});
async function open(account=admin) {
  const context=await browser.newContext();
  await context.addInitScript(({token,operator})=>{
    localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.staff.role',operator.role);
    localStorage.setItem('mbbs.staff.roles',JSON.stringify(operator.roles));
  },account);
  const page=await context.newPage();await page.goto(base+'/admin/menu-order');
  return {page,context};
}
function rows(page) {return page.locator('.menu-order-row').evaluateAll(nodes=>nodes.map(node=>node.dataset.href));}
function cards(page) {return page.locator('[data-menu-group] > .dispatch-menu-card').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('onclick').match(/location\.href='([^']+)'/)[1]));}
test('Admin can move rows, retain edits between menus, save and see sidebar and cards follow',async()=>{
  const {page,context}=await open();
  try {
    await expect(page.getByRole('heading',{name:'Menu order',exact:true})).toBeVisible();
    await page.locator('#menuOrderGroup').selectOption('sales');
    const initial=await rows(page);
    await page.getByRole('button',{name:'Move SO Printing up',exact:true}).click();
    const changed=await rows(page);assert.notDeepEqual(changed,initial);
    await page.locator('#menuOrderGroup').selectOption('dispatch');
    await page.getByRole('button',{name:'Move Setup up',exact:true}).click();
    await page.locator('#menuOrderGroup').selectOption('sales');assert.deepEqual(await rows(page),changed);
    await page.getByRole('button',{name:'Save menu order',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('saved for everyone');
    await page.goto(base+'/sales');
    await expect.poll(()=>cards(page)).toEqual(changed.filter(href=>href!=='/sales'));
    await expect.poll(()=>page.locator('nav[aria-label="Sales pages"] .app-sidebar-link').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')))).toEqual(changed);
    const scm=await context.newPage();await scm.goto(base+'/scm');await expect(scm.locator('[data-menu-group="scm"]')).toBeVisible();
  } finally {await context.close();}
});
test('drag and drop changes order and conflicts preserve unsaved edits',async()=>{
  const {page,context}=await open();
  try {
    // Keep both ends visible: dragTo's target auto-scroll otherwise moves the
    // source coordinates before Chromium starts the native drag.
    await page.setViewportSize({width:1280,height:1200});
    await expect(page.locator('.menu-order-row').first()).toBeVisible();
    const original=await rows(page);
    await page.evaluate(()=>{
      window.menuDragEvents=[];
      for(const type of ['dragstart','drop']) {document.addEventListener(type,event=>window.menuDragEvents.push({type,href:event.target.closest('[data-href]')?.dataset.href}));}
    });
    await page.locator('.menu-order-row').first().dragTo(page.locator('.menu-order-row').last());
    assert.deepEqual(await page.evaluate(()=>window.menuDragEvents),[
      {type:'dragstart',href:original[0]},{type:'drop',href:original.at(-1)}
    ]);
    assert.deepEqual(await rows(page),[...original.slice(1),original[0]]);
    await query('UPDATE app_menu_order_settings SET revision=revision+1 WHERE id=true');
    await page.getByRole('button',{name:'Save menu order',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('changed since you loaded');
    assert.deepEqual(await rows(page),[...original.slice(1),original[0]]);
    await expect(page.getByRole('button',{name:'Save menu order',exact:true})).toBeEnabled();
  } finally {await context.close();}
});
test('reset restores original card order; reordering preserves role filtering and badge identity',async()=>{
  const {page,context}=await open();
  try {
    await page.goto(base+'/dispatch');await expect(page.locator('[data-menu-group]')).toBeVisible();
    const original=await cards(page);
    const changed=[...original].reverse();
    await page.evaluate(()=>{window.badge=document.getElementById('dispatchMenuOfflineReviewCount');});
    await page.evaluate(orders=>window.MBBSMenuOrder.setSnapshot({revision:999,orders:{dispatch:orders}}),changed);
    assert.deepEqual(await cards(page),changed);
    assert.ok(await page.evaluate(()=>window.badge===document.getElementById('dispatchMenuOfflineReviewCount')));
    await page.evaluate(()=>window.MBBSMenuOrder.setSnapshot({revision:1000,orders:{}}));assert.deepEqual(await cards(page),original);
    const viewer=await browser.newContext();
    await viewer.addInitScript(({token})=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.staff.role','sales');},sales);
    const salesPage=await viewer.newPage();await salesPage.goto(base+'/sales');
    await expect(salesPage.locator('nav[aria-label="Main modules"]')).toBeVisible();
    await salesPage.evaluate(()=>window.MBBSMenuOrder.setSnapshot({revision:999,orders:{main:['/admin','/dispatch','/sales']}}));
    assert.equal(await salesPage.locator('nav[aria-label="Main modules"] a[href="/admin"]').count(),0);
    assert.equal(await salesPage.locator('nav[aria-label="Main modules"] a[href="/dispatch"]').count(),0);
    await viewer.close();
  } finally {await context.close();}
});
test('read failures and older responses retain the working order',async()=>{
  const {page,context}=await open();
  try {
    await expect(page.locator('.menu-order-row').first()).toBeVisible();
    await page.evaluate(()=>window.MBBSMenuOrder.setSnapshot({revision:999,orders:{admin:['/admin/menu-order']}}));
    await page.route('**/api/navigation/menu-order',route=>route.fulfill({status:503,body:'unavailable'}));
    await page.evaluate(()=>window.MBBSMenuOrder.refresh());
    assert.equal(await page.locator('nav[aria-label="Admin pages"] a').first().getAttribute('href'),'/admin/menu-order');
    await page.evaluate(()=>window.MBBSMenuOrder.setSnapshot({revision:2,orders:{}}));
    assert.equal(await page.locator('nav[aria-label="Admin pages"] a').first().getAttribute('href'),'/admin/menu-order');
  } finally {await context.close();}
});
