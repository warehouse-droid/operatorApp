/* global localStorage, document, Element, window */
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {writeFile} from 'node:fs/promises';
import fc from 'fast-check';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {createScmPurchaseOrderSplit,listScmPurchaseOrders} from '../../../src/dispatch-repository.js';
import {upsertScmPurchaseOrderCatalog,getScmPurchaseOrderCatalogOrder} from '../../../src/scm-purchase-order-catalog-repository.js';
import {createSpecialPurchaseOrderRoutingService} from '../../../src/special-stock-purchase-order-routing.js';
import {withBackorderWorkflow} from '../../../src/stock-case-workflow.js';

let f,browser;
before(async()=>{f=await fixture({sku:88770901});});
after(async()=>{await browser?.close();await f?.close();});
async function setup() {
  let d=await f.create(1);d=await f.review(d);
  d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});
  const parent=887709100+d.id,ref='TEST-BACKORDER-PO-'+parent;
  await f.query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,vendor,status,status_text,netsuite_active,destination_location_id,destination_location,netsuite_note) VALUES($1,$2,331,'TEST Vendor','B','Purchase Order : Pending Receipt',true,1,'3445','Parent note')",[parent,ref]);
  const line=(await f.query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,sku,item_name,quantity,unit,netsuite_active,netsuite_received_baseline_qty) VALUES($1,1,88770901,'TEST','TEST material',20,'EA',true,0) RETURNING id",[parent])).rows[0];
  const children=[];
  for(const suffix of ['A','B']) {children.push((await createScmPurchaseOrderSplit({sourcePoRef:ref,newPoRef:ref+'-'+suffix,destinationLocationId:1,lines:[{lineRowId:line.id,salesQty:2}],createdBy:f.users.scm.id})).split);}
  d=await f.action(d,'scm','purchase-order/link',{purchaseOrderRef:ref});
  await upsertScmPurchaseOrderCatalog({orders:await listScmPurchaseOrders({search:ref}),source:'backorder-routing-test'});
  return {d,parent,ref,children};
}
const path=d=>`/api/scm/stock-requests/${d.id}/backorder/purchase-order/`;
async function http(d,action,{role='scm',method='GET',body}={}) {
  const response=await fetch(f.base+path(d)+action,{method,headers:{'content-type':'application/json',...(role?{authorization:'Bearer '+f.users[role].token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const text=await response.text();
  return {status:response.status,body:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text};
}
const attach=(d,id)=>http(d,'link',{method:'POST',body:{expectedRevision:d.revision,purchaseOrderSplitId:id}});

test('whole Backorder routing resolves the linked vendor and saves the parent with the NetSuite boundary isolated',async()=>{
  const {d,parent,ref,children}=await setup(),writes=[];
  const service=createSpecialPurchaseOrderRoutingService({readNote:async identity=>{
    assert.equal(identity.vendorId,331);assert.equal(identity.purchaseOrderId,parent);return 'Initial remote note';
  },updateNote:async identity=>{writes.push(identity);return identity.note;}});
  assert.deepEqual(await withBackorderWorkflow(()=>service.readNote(d.id)),{note:'Initial remote note'});
  const order=await getScmPurchaseOrderCatalogOrder(ref,{includeRestricted:true});
  const siblings=async()=> (await f.query('SELECT * FROM scm_transport_schedule WHERE order_ref=ANY($1::text[]) ORDER BY order_ref',[children.map(child=>child.splitPoRef)])).rows;
  const beforeRows=await siblings();
  await withBackorderWorkflow(()=>service.save(d.id,{expectedRevision:d.revision,expectedUpdatedAt:order.scm?.updatedAt || null,
    expectedNote:'Initial remote note',notes:'Whole PO note',method:'Vendor'},{operatorId:f.users.scm.id}));
  assert.deepEqual(await siblings(),beforeRows);
  assert.equal(writes.length,1);assert.equal(writes[0].vendorId,331);assert.equal(writes[0].purchaseOrderId,parent);
  assert.equal((await f.query('SELECT netsuite_note FROM purchase_orders WHERE netsuite_id=$1',[parent])).rows[0].netsuite_note,'Whole PO note');
  assert.equal((await f.detail(d,'scm')).purchaseOrderSplitId,null);
});

test('Backorder lists only active source children and keeps SCM and workflow permissions',async()=>{
  const {d,children}=await setup();
  const choices=await http(d,'splits');assert.equal(choices.status,200,JSON.stringify(choices));
  assert.deepEqual(choices.body.splits.map(row=>row.id),children.map(row=>Number(row.id)));
  for(const action of ['splits','note']) {
    assert.equal((await http(d,action,{role:null})).status,401);
    assert.equal((await http(d,action,{role:'sales'})).status,403);
  }
  assert.equal((await http(d,'routing',{role:'sales',method:'PUT',body:{expectedRevision:d.revision}})).status,403);
  const special=await f.http('scm',`/api/scm/special-stock-requests/${d.id}/purchase-order/splits`);
  assert.equal(special.status,404);
  await f.query("UPDATE dispatch_scm_po_splits SET status='cancelled',cancelled_at=now() WHERE id=$1",[children[0].id]);
  assert.deepEqual((await http(d,'splits')).body.splits.map(row=>row.id),[Number(children[1].id)]);
});

test('Backorder attaches and detaches a child with revision checks and unchanged source and sibling',async()=>{
  const {d,parent,children}=await setup();
  const rows=async()=> (await f.query('SELECT * FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id',[[parent,...children.map(c=>c.splitPoId)]])).rows;
  const beforeRows=await rows();
  const result=await attach(d,children[1].id);assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.body.purchaseOrderSplitId,Number(children[1].id));
  assert.equal(result.body.purchaseOrderTargetRef,children[1].splitPoRef);
  assert.equal(result.body.purchaseOrderId,parent);
  assert.deepEqual(await rows(),beforeRows);
  assert.equal((await attach(d,children[0].id)).status,409);
  const competing=await Promise.all([attach(result.body,null),attach(result.body,children[0].id)]);
  assert.deepEqual(competing.map(row=>row.status).sort(),[200,409]);
  assert.equal((await f.detail(d,'scm')).revision,result.body.revision+1);
});

test('Backorder rejects foreign, invalid, cancelled, received and planned child attachments without changing revision',async()=>{
  const {d,children}=await setup(),other=await setup();
  const baseline=(await http(d,'splits'));assert.equal(baseline.status,200);
  await fc.assert(fc.asyncProperty(fc.oneof(fc.integer({min:-10000,max:-1}),fc.constantFrom('bad',1.5,999999999)),async id=>{
    assert.ok([400,409].includes((await attach(d,id)).status));
    assert.equal((await f.detail(d,'scm')).revision,d.revision);
  }),{seed:166,numRuns:15});
  assert.equal((await attach(d,other.children[0].id)).status,409);
  await f.query("UPDATE dispatch_scm_po_splits SET status='cancelled',cancelled_at=now() WHERE id=$1",[children[0].id]);
  assert.equal((await attach(d,children[0].id)).status,409);
  await f.query('UPDATE purchase_order_lines SET netsuite_received_qty=1 WHERE purchase_order_id=$1',[children[1].splitPoId]);
  assert.equal((await attach(d,children[1].id)).status,409);
  await f.query('UPDATE purchase_order_lines SET netsuite_received_qty=0 WHERE purchase_order_id=$1',[children[1].splitPoId]);
  const plan=(await f.query("INSERT INTO dispatch_plans(plan_date,status) SELECT day::date,'draft' FROM generate_series(DATE '2098-01-01',DATE '2098-12-31',INTERVAL '1 day') day WHERE NOT EXISTS(SELECT 1 FROM dispatch_plans WHERE plan_date=day::date) ORDER BY day LIMIT 1 RETURNING id,plan_date")).rows[0];
  await f.query("INSERT INTO dispatch_plan_order_assignments(plan_id,plan_date,order_ref,planned_order_ref) VALUES($1,$2,$3,$3)",[plan.id,plan.plan_date,children[1].splitPoRef]);
  assert.equal((await attach(d,children[1].id)).status,409);
  assert.equal((await f.detail(d,'scm')).revision,d.revision);
});

test('SCM Backorder browser selects a child, saves its routing, preserves failed drafts and isolates notes',async()=>{
  const {d,parent,children}=await setup();
  browser ||= await chromium.launch({args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  try {
    await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),f.users.scm.token);
    const page=await context.newPage();page.setDefaultTimeout(8000);
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.route('**/backorder/purchase-order/note',route=>route.fulfill({json:{note:'Parent note'}}));
    const errors=[],saves=[];page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.method()==='PUT'&&request.url().endsWith('/purchase-order/routing')) {saves.push(request.postDataJSON());}});
    await page.goto(f.base+`/scm/stock-requests?tab=regular&requestId=${d.id}`);
    await page.locator(`[data-scm-stock-action="select"][data-id="${d.id}"]`).click();
    await expect(page.getByLabel('Attached PO',{exact:true})).toBeVisible();
    await expect(page.locator('[data-backorder-po-routing-form] [name=notes]')).toHaveValue('Parent note');
    await page.getByLabel('Attached PO',{exact:true}).selectOption(String(children[1].id));
    await page.getByRole('button',{name:'Attach selected PO',exact:true}).click();
    const form=page.locator('[data-backorder-po-routing-form]');
    await expect(form).toContainText('Saved to this child PO.');
    await expect(form.locator('[name=packingSlipRef]')).toHaveValue(children[1].splitPoRef);
    await expect(form.locator('[name=packingSlipRef]')).toHaveAttribute('readonly','');
    const snapshot=async()=> (await f.query('SELECT * FROM scm_transport_schedule WHERE order_ref=ANY($1::text[]) ORDER BY order_ref',[[d.purchaseOrderRef,children[0].splitPoRef]])).rows;
    const unchanged=await snapshot();
    await form.locator('[name=method]').selectOption('Vendor');
    await form.locator('[name=notes]').fill('Collect the selected child');
    await page.route('**/backorder/purchase-order/routing',route=>route.fulfill({status:409,json:{error:'This schedule changed. Reload before saving.'}}),{times:1});
    await form.getByRole('button',{name:'Save Schedule',exact:true}).click();
    await expect(page.locator('[data-backorder-po-error]')).toContainText('schedule changed');
    await expect(form.locator('[name=notes]')).toHaveValue('Collect the selected child');
    await form.getByRole('button',{name:'Save Schedule',exact:true}).click();
    await expect.poll(async()=> (await f.query('SELECT notes FROM scm_transport_schedule WHERE order_ref=$1',[children[1].splitPoRef])).rows[0]?.notes).toBe('Collect the selected child');
    assert.deepEqual(await snapshot(),unchanged);
    assert.equal((await f.query('SELECT netsuite_note FROM purchase_orders WHERE netsuite_id=$1',[parent])).rows[0].netsuite_note,'Parent note');
    assert.equal((await http(d,'note')).body.note,'Collect the selected child');
    assert.equal((await http(d,'routing',{method:'PUT',body:saves.at(-1)})).status,409);
    await page.reload();
    await page.locator(`[data-scm-stock-action="select"][data-id="${d.id}"]`).click();
    await expect(page.getByLabel('Attached PO',{exact:true})).toHaveValue(String(children[1].id));
    await expect(form.locator('[name=notes]')).toHaveValue('Collect the selected child');
    await f.query('UPDATE scm_transport_schedule SET notes=$2,updated_at=now() WHERE order_ref=$1',[children[1].splitPoRef,'Updated from PO Schedule']);
    await page.locator('[data-scm-stock-action="refresh"]').click();
    await expect(form.locator('[name=notes]')).toHaveValue('Updated from PO Schedule');
    assert.deepEqual(errors,[]);
    await writeFile('test-artifacts/backorder-po-browser.json',JSON.stringify(await page.coverage.stopJSCoverage()));
  } finally {await context.close();}
});

test('Backorder routing retries failures and ignores late responses after switching requests',async()=>{
  const first=await setup(),second=await setup();
  assert.equal((await attach(first.d,first.children[0].id)).status,200);
  assert.equal((await attach(second.d,second.children[1].id)).status,200);
  browser ||= await chromium.launch({args:['--no-sandbox']});
  const context=await browser.newContext({serviceWorkers:'block'});
  let unblock;
  const gate=new Promise(resolve=>{unblock=resolve;});
  try {
    await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),f.users.scm.token);
    await context.addInitScript(id=>localStorage.setItem('mbbs.scm.stockRequests.selected',String(id)),first.d.id);
    const page=await context.newPage();page.setDefaultTimeout(8000);
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    let waiting=false,unavailable=true;
    // Keep the outage in place until the actual retry click; unrelated async
    // renders must not recover the endpoint before the button can be clicked.
    await page.exposeFunction('__mbbsAllowPoRoutingRetry',()=>{unavailable=false;});
    await page.addInitScript(()=>document.addEventListener('click',event=>{
      if(event.target instanceof Element && event.target.closest('[data-backorder-po-reload]')) {
        void window.__mbbsAllowPoRoutingRetry();
      }
    },true));
    const firstUrl='**/api/dispatch/scm/v2/purchase-orders/'+first.children[0].splitPoRef;
    await page.route(firstUrl,async route=>{waiting=true;await gate;await route.continue();});
    await page.route('**/api/dispatch/scm/v2/purchase-orders/'+second.children[1].splitPoRef,
      route=>unavailable?route.fulfill({status:503,json:{error:'Routing temporarily unavailable'}}):route.continue());
    await page.goto(f.base+`/scm/stock-requests?tab=regular&search=${encodeURIComponent(first.d.requestRef+', '+second.d.requestRef)}`);
    await page.locator(`[data-scm-stock-action="select"][data-id="${first.d.id}"]`).click();
    await expect.poll(()=>waiting).toBe(true);
    await page.locator(`[data-scm-stock-action="select"][data-id="${second.d.id}"]`).click();
    await expect(page.locator('[data-backorder-po-panel]')).toContainText('Routing temporarily unavailable');
    await page.getByRole('button',{name:'Retry PO routing'}).click();
    await expect(page.locator('[data-backorder-po-routing-form] [name=packingSlipRef]')).toHaveValue(second.children[1].splitPoRef);
    const finished=page.waitForResponse(response=>response.url().endsWith(first.children[0].splitPoRef));
    unblock();await finished;
    await expect(page.locator('[data-backorder-po-routing-form] [name=packingSlipRef]')).toHaveValue(second.children[1].splitPoRef);
    await expect(page.getByLabel('Attached PO',{exact:true})).toHaveValue(String(second.children[1].id));
    await writeFile('test-artifacts/backorder-po-race-browser.json',JSON.stringify(await page.coverage.stopJSCoverage()));
  } finally {unblock();await context.close();}
  const sales=await browser.newContext({serviceWorkers:'block'});
  try {
    await sales.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),f.users.sales.token);
    const page=await sales.newPage();await page.goto(f.base+`/sales/stock-requests?tab=regular&requestId=${second.d.id}`);
    await expect(page.locator('[data-backorder-detail]')).toBeVisible();
    await expect(page.locator('[data-backorder-po-panel]')).toHaveCount(0);
  } finally {await sales.close();}
});
