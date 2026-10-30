import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {chromium,expect} from '@playwright/test';

let f,browser;const orders=[];
before(async()=>{f=await fixture({sku:88999481});});
after(async()=>{await browser?.close();if(f){await f.query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])',[orders]);await f.close();}});
async function linked({allOrdered=false}={}) {
  let d=await f.ordered(await f.create());
  d=allOrdered?await f.ordered(d,1):await f.review(d,1);
  const id=8899948100+orders.length,ref='TEST-LINKED-SO-'+id;orders.push(id);
  await f.query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active,operator_status,local_yard_order_status,fulfillment_status) VALUES($1,$2,'B','Sales Order : Pending Fulfillment',true,'open','Open','not_fulfilled')",[id,ref]);
  await f.query("INSERT INTO sales_order_lines(sales_order_id,item_id,item_type,quantity,unit,loaded_qty,netsuite_active) VALUES($1,$2,'InvtPart',10,'EA',0,true),($1,$2,'InvtPart',5,'EA',0,true)",[id,88999481]);
  d=await f.action(d,'sales','already-ordered/sales-order',{salesOrderRef:ref});
  return {d,id,ref};
}

test('attached SO and SCM responses put mixed and all-ordered requests In Progress in both portals and filters',async()=>{
  for(const allOrdered of [false,true]) {
    const {d}=await linked({allOrdered});
    const before=(await f.query('SELECT status,revision,regular_details FROM sales_stock_requests WHERE id=$1',[d.id])).rows;
    for(const role of ['sales','scm']) {
      const detail=await f.detail(d,role);
      assert.equal(detail.statusSummary.status,'in_progress');assert.equal(detail.statusSummary.counts.pending_sales,0);
      const list=await f.http(role,`/api/${role}/stock-requests?`+new URLSearchParams({search:d.requestRef,unifiedStatus:'in_progress',queue:''}));
      assert.equal(list.status,200);assert.deepEqual(list.body.requests.map(r=>r.id),[d.id]);
    }
    const alerts=(await f.http('sales','/api/sales/stock-requests/alerts')).body;
    assert.ok(!alerts.requests.some(row=>row.id===d.id&&row.action==='input_required'));
    assert.deepEqual((await f.query('SELECT status,revision,regular_details FROM sales_stock_requests WHERE id=$1',[d.id])).rows,before);
  }
});

test('SO fulfillment completes the request without requiring the header PO or rewriting the workflow',async()=>{
  const {d,id}=await linked();
  await f.query("UPDATE sales_orders SET status_text='Sales Order : Fulfilled',fulfillment_status='fulfilled',fulfilled_at=now() WHERE netsuite_id=$1",[id]);
  for(const role of ['sales','scm']) {
    const saved=await f.detail(d,role);
    assert.equal(saved.statusSummary.status,'completed');assert.equal(saved.salesOrderId,null);assert.equal(saved.purchaseOrderId,null);
    assert.equal(saved.revision,d.revision);assert.deepEqual(saved.statusSummary.waitingReasons,[]);
    const result=await f.http(role,`/api/${role}/stock-requests?`+new URLSearchParams({search:d.requestRef,unifiedStatus:'completed',queue:''}));
    assert.equal(result.status,200);assert.deepEqual(result.body.requests.map(row=>row.id),[d.id]);
  }
});

test('local loading must cover every cargo line, and a later reopen removes completion',async()=>{
  const {d,id}=await linked();
  await f.query("UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='Loaded' WHERE netsuite_id=$1",[id]);
  await f.query('UPDATE sales_order_lines SET loaded_qty=quantity-1 WHERE sales_order_id=$1',[id]);
  assert.equal((await f.detail(d)).statusSummary.status,'in_progress');
  await f.query('UPDATE sales_order_lines SET loaded_qty=quantity WHERE sales_order_id=$1',[id]);
  assert.equal((await f.detail(d)).statusSummary.status,'completed');
  await f.query("UPDATE sales_orders SET operator_status='open',local_yard_order_status='Open',fulfillment_status='not_fulfilled',fulfilled_at=NULL WHERE netsuite_id=$1",[id]);
  await f.query('UPDATE sales_order_lines SET loaded_qty=0 WHERE sales_order_id=$1',[id]);
  assert.equal((await f.detail(d)).statusSummary.status,'in_progress');
});

test('unknown or ambiguous attached SOs never supply completion evidence',async()=>{
  let d=await f.ordered(await f.create(1));
  d=await f.action(d,'sales','already-ordered/sales-order',{salesOrderRef:'TEST-UNKNOWN-SO'});
  assert.equal((await f.detail(d)).statusSummary.status,'in_progress');
  const {d:known,id,ref}=await linked();
  const duplicate=id+100;orders.push(duplicate);
  await f.query("INSERT INTO sales_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES($1,$2,'Fulfilled',true)",[duplicate,ref]);
  await f.query("UPDATE sales_orders SET status_text='Fulfilled' WHERE netsuite_id=$1",[id]);
  assert.equal((await f.detail(known)).statusSummary.status,'in_progress');
});

test('Sales and SCM browsers show In Progress, then Completed after the linked SO is fully loaded',async()=>{
  const {d,id}=await linked();
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const role of ['sales','scm']) {
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);window.MBBSOSNotifications={allowsRole:()=>false,notify:async()=>false};},f.users[role].token);
    try {
      await f.query('UPDATE sales_order_lines SET loaded_qty=0 WHERE sales_order_id=$1',[id]);
      await page.goto(`${f.base}/${role}/stock-requests?tab=regular&requestId=${d.id}`);
      await expect(page.locator('.stock-request-detail [data-regular-main-status]')).toHaveAttribute('data-regular-main-status','in_progress');
      await f.query("UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='Loaded' WHERE netsuite_id=$1",[id]);
      await f.query('UPDATE sales_order_lines SET loaded_qty=quantity WHERE sales_order_id=$1',[id]);
      await page.locator(`[data-${role}-stock-action=refresh]`).click();
      await expect(page.locator('.stock-request-detail [data-regular-main-status]')).toHaveAttribute('data-regular-main-status','completed');
      assert.deepEqual(errors,[]);
    } finally {await context.close();}
  }
});
