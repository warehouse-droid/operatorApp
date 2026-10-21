/* global localStorage, document, Node */
import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

let browser,capture=0;
const out=process.env.SPECIAL_BATCH_BROWSER_OUTPUT || 'test-artifacts/special-po-pallet-routing/browser';
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({channel:'chromium',args:['--no-sandbox']});});
after(async()=>browser?.close());
async function fixture(created=false,width=1440,configure=()=>{}) {
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','test-pallet'));
  const page=await context.newPage();page.setDefaultTimeout(5000);
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  const record={id:1,requestRef:'SPREQ-PALLET',revision:7,stage:'confirmed',closeStatus:'active',storeName:'3445',storeLocationId:1,customerName:'TEST',vendorName:'TEST Vendor',vendorId:331,
    salesOrderId:10,salesOrderApproved:true,purchaseOrderId:created?20:null,purchaseOrderRef:created?'TEST-PO':null,purchaseOrderApproved:true,
    palletTotal:2,palletRate:40,fulfillmentMethod:'yard_pickup',events:[],media:[],readinessAlerts:[],
    lines:[{id:1,productName:'TEST product',quantity:24,uom:'PC',supplyStatus:'in_stock',salesDecision:'accepted',vendorYard:'Pickup A'}],
    purchaseOrderLines:[{caseLineId:1,itemId:2055,description:'TEST product',quantity:24,uom:'PC',unitPurchaseCost:33.87}]};
  const order={id:'TEST-PO',originalPoRef:'TEST-PO',type:'PO',destinationYard:'3445',vendorYard:'Pickup A',notes:'for SOB121819',netSuiteNote:'for SOB121819',vendorYardOptions:[{yard:'Pickup A'},{yard:'Pickup B'}],
    items:[{lineRowId:1,lineId:1,sku:'TEST',itemName:'TEST product',quantity:24,unit:'PC',pallets:2,toPlt:12,toPcs:1}],
    scm:{method:'MBT',status:'Hold',pickupPoint:'Pickup A',isSpecialOrder:true,packingSlipRef:'',dropoffPoint:'',notes:'',netSuiteMemo:'Pickering Yard - Unilock',remarkOverride:'',updatedAt:'2099-01-01T00:00:00.123456+00:00'}};
  const state={record,order,posts:[],remoteNotes:[],errors:[],fail:false,records:[record],orders:new Map([['TEST-PO',order]]),delays:new Map(),reads:[]};
  configure(state);
  page.on('pageerror',e=>state.errors.push(e.message));
  await page.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.startsWith('/api/')) {
      if(['POST','PUT'].includes(route.request().method())) {
        const body=route.request().postDataJSON();state.posts.push({path,body,method:route.request().method()});
        if(state.fail)return route.fulfill({status:409,json:{error:'This schedule row changed. Refresh and try again.'}});
        if(path.startsWith('/api/scm/schedule/') || path.endsWith('/purchase-order/routing')) {
          let patch=body;
          if(path.endsWith('/purchase-order/routing')) {
            const {notes,expectedNote,expectedRevision,...routing}=body;
            assert.equal(expectedNote,order.netSuiteNote);assert.equal(expectedRevision,record.revision);
            state.remoteNotes.push(notes);order.netSuiteNote=notes;order.notes=notes;patch=routing;
          }
          Object.assign(order.scm,patch,{updatedAt:'2099-01-02T00:00:00.654321+00:00'});
          const displayRef=body.packingSlipRef || order.originalPoRef;
          if(displayRef!==order.id) {
            state.orders.delete(order.id);order.id=displayRef;state.orders.set(displayRef,order);
            record.purchaseOrderReference=body.packingSlipRef || '';
          }
          return route.fulfill({json:{updated:{},row:{orderRef:order.id,...order.scm}}});
        }
        if(path.endsWith('/purchase-order/create'))Object.assign(record,{purchaseOrderId:20,purchaseOrderRef:'TEST-PO'});
        record.revision++;return route.fulfill({json:record});
      }
      if(path.endsWith('/purchase-order/note')) {
        const id=path.split('/')[4],selected=state.records.find(row=>String(row.id)===id);
        const po=[...state.orders.values()].find(value=>value.originalPoRef===selected?.purchaseOrderRef);
        return route.fulfill({json:{note:po?.netSuiteNote || ''}});
      }
      if(path.startsWith('/api/dispatch/scm/v2/purchase-orders/')) {
        const ref=decodeURIComponent(path.split('/').at(-1)), selected=state.orders.get(ref);
        state.reads.push(ref);
        if(!selected)return route.fulfill({status:404,json:{error:'Purchase order not found'}});
        if(state.delays.has(ref))await state.delays.get(ref);
        return route.fulfill({json:{order:{...selected,scm:{...selected.scm,notes:selected.scm.notes || selected.netSuiteNote}}}});
      }
      if(path==='/api/dispatch/scm/v2/purchase-orders')return route.fulfill({json:{orders:[{...order,scm:{...order.scm,notes:order.scm.notes || order.netSuiteNote}}],total:1}});
      if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'test-pallet',role:'scm',roles:['scm']}}});
      if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
      if(/special-stock-requests\/\d+$/.test(path))return route.fulfill({json:state.records.find(row=>String(row.id)===path.split('/').at(-1))});
      if(path.endsWith('/special-stock-requests'))return route.fulfill({json:{requests:state.records,yards:[{locationId:1,yardCode:'3445'}]}});
      return route.fulfill({json:{requests:[],yards:[],total:0}});
    }
    const file=path==='/scm/stock-requests'?'/scm-stock-requests.html':path==='/scm/POsplit'?'/dispatch-scm.html':path;
    try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}
    catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto('http://localhost/scm/stock-requests?tab=special');
  await page.locator('.stock-request-card[data-id="1"]').click();
  return {page,state,close:async()=>{
    await writeFile(`${out}/coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));
    await context.close();
  }};
}

test('SCM reviews PALLET quantity and cost, keeps failed input and submits it separately from material discounts',async()=>{
  const {page,state,close}=await fixture(false,390);
  try {
    const form=page.locator('[data-special-po-form]');
    await expect(form.locator('[name=purchasePalletQuantity]')).toHaveValue('2');
    await expect(form.locator('[name=purchasePalletCost]')).toHaveValue('');
    await form.locator('[name=vendorDiscountPercent]').fill('10');
    await form.getByRole('button',{name:'Create PO in NetSuite'}).click();assert.equal(state.posts.length,0);
    await form.locator('[name=purchasePalletCost]').fill('35');
    await expect(form.locator('[data-special-purchase-totals]')).toContainText('801.59');
    state.fail=true;await form.getByRole('button',{name:'Create PO in NetSuite'}).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('changed');
    await expect(form.locator('[name=purchasePalletCost]')).toHaveValue('35');
    state.fail=false;await form.getByRole('button',{name:'Create PO in NetSuite'}).click();
    await expect.poll(()=>state.posts.length).toBe(2);
    assert.deepEqual(state.posts[1].body.pallet,{quantity:'2',unitPurchaseCost:'35'});
    assert.equal(state.posts[1].body.lines.length,1);
    await expect(page.locator('.scm-mini-routing-row')).toBeVisible();
    assert.deepEqual(state.errors,[]);
    await page.screenshot({path:out+'/pallet-created-mobile.png',fullPage:true});
  } finally {await close();}
});

test('created PO routing saves the real Note and exact schedule revision, preserving failed drafts',async()=>{
  const {page,state,close}=await fixture(true);
  try {
    const form=page.locator('[data-special-po-routing-form]');
    await expect(form.locator('.scm-mini-routing-row')).toBeVisible();
    await expect(page.getByLabel('Stock readiness').locator('option[value="true"]')).toHaveText('Ready for Arrangement');
    await expect(page.getByRole('link',{name:'Open PO Split',exact:true})).toHaveCount(0);
    const layouts=[];
    for(const width of [1440,1280,1024]) {
      await page.setViewportSize({width,height:1000});
      const layout=await form.evaluate(element=>{
        const rows=[...element.querySelectorAll('.scm-mini-row')];
        return rows.map(row=>{
          const bounds=row.getBoundingClientRect();
          return {height:bounds.height,fields:[...row.children].map(field=>{
            const rect=field.getBoundingClientRect();
            return {bottom:rect.bottom,right:rect.right,rowBottom:bounds.bottom,rowRight:bounds.right};
          })};
        });
      });
      assert.equal(layout.length,2);
      assert.deepEqual(layout.map(row=>row.fields.length),[5,4]);
      for(const row of layout)for(const field of row.fields) {
        assert.ok(Math.abs(field.bottom-row.fields[0].bottom)<1,'Fields must share the same row');
        assert.ok(field.right<=field.rowRight+1,'Fields must fit inside the mini panel');
      }
      layouts.push({width,rows:layout});
    }
    await writeFile(out+'/mini-layout.json',JSON.stringify(layouts,null,2));
    await page.setViewportSize({width:1440,height:1000});
    await form.locator('[data-scm-field=method]').selectOption('Vendor');
    await form.locator('[data-scm-field=status]').selectOption('Priority');
    await form.locator('[data-scm-field=pickupPoint]').selectOption('Pickup B');
    await form.locator('[data-scm-field=isSpecialOrder]').uncheck();
    await form.locator('[data-scm-field=packingSlipRef]').fill('PACK-17');
    await form.locator('[data-scm-field=dropoffPoint]').selectOption('2967');
    await form.locator('[data-scm-field=remarkOverride]').fill('Call before pickup <img src=x>');
    await form.locator('[data-scm-field=notes]').fill('Bring signed PO <img src=x>');
    state.fail=true;await form.getByRole('button',{name:'Save Schedule',exact:true}).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('changed');
    await expect(form.locator('[data-scm-field=remarkOverride]')).toHaveValue('Call before pickup <img src=x>');
    await expect(form.locator('[data-scm-field=notes]')).toHaveValue('Bring signed PO <img src=x>');
    state.fail=false;await form.getByRole('button',{name:'Save Schedule',exact:true}).click();
    await expect.poll(()=>state.posts.length).toBe(2);
    assert.deepEqual(state.posts[1],{path:'/api/scm/special-stock-requests/1/purchase-order/routing',method:'PUT',body:{orderKind:'PO',expectedRevision:7,expectedNote:'for SOB121819',expectedUpdatedAt:'2099-01-01T00:00:00.123456+00:00',
      method:'Vendor',status:'Priority',pickupPoint:'Pickup B',isSpecialOrder:false,packingSlipRef:'PACK-17',dropoffPoint:'2967',remarkOverride:'Call before pickup <img src=x>',notes:'Bring signed PO <img src=x>'}});
    await expect(form.locator('[data-scm-field=packingSlipRef]')).toHaveValue('PACK-17');
    await expect(form.locator('img')).toHaveCount(0);
    assert.deepEqual(state.errors,[]);
    await page.screenshot({path:out+'/routing-saved.png',fullPage:true});
  } finally {await close();}
});

test('Special Request edits the real Note while PO Split edits remain local, with the bar above line responses',async()=>{
  const {page,state,close}=await fixture(true,390);
  try {
    const form=page.locator('[data-special-po-routing-form]');
    await expect(form.locator('[data-scm-field=remarkOverride]')).toHaveValue('Pickering Yard - Unilock');
    await expect(form.locator('[data-scm-field=notes]')).toHaveValue('for SOB121819');
    assert.equal(await page.evaluate(()=>Boolean(document.querySelector('.special-po-routing').compareDocumentPosition(document.querySelector('[data-special-stock-check-form]')) & Node.DOCUMENT_POSITION_FOLLOWING)),true);
    await expect(page.locator('[data-special-po-reference-form], .stock-request-detail .stock-request-wide')).toHaveCount(0);
    await expect(page.locator('[data-scm-field=packingSlipRef]')).toHaveCount(1);
    await form.locator('[data-scm-field=notes]').fill('Special request Note');
    await form.getByRole('button',{name:'Save Schedule',exact:true}).click();
    await expect.poll(()=>state.posts.length).toBe(1);
    assert.equal(state.posts[0].body.remarkOverride,'','An unchanged PO memo must remain mapped from NetSuite');
    await page.goto('http://localhost/scm/POsplit?order=TEST-PO');
    await expect(page.locator('[data-scm-field=remarkOverride]')).toHaveValue('Pickering Yard - Unilock');
    await expect(page.locator('[data-scm-field=notes]')).toHaveValue('Special request Note');
    await page.locator('[data-scm-field=remarkOverride]').fill('PO Split remark </textarea><img src=x>');
    await page.locator('[data-scm-field=notes]').fill('PO Split Note <img src=x>');
    state.fail=true;await page.getByRole('button',{name:'Save Schedule',exact:true}).click();
    await expect(page.locator('[data-scm-field=notes]')).toHaveValue('PO Split Note <img src=x>');
    state.fail=false;await page.getByRole('button',{name:'Save Schedule',exact:true}).click();
    await expect.poll(()=>state.posts.length).toBe(3);
    assert.equal(state.posts[2].body.notes,'PO Split Note <img src=x>');
    assert.equal(state.posts[2].body.remarkOverride,'PO Split remark </textarea><img src=x>');
    assert.deepEqual(state.remoteNotes,['Special request Note']);
    assert.equal(state.posts[2].path,'/api/scm/schedule/TEST-PO');
    await page.goto('http://localhost/scm/stock-requests?tab=special');
    await expect(page.locator('[data-special-po-routing-form] [data-scm-field=remarkOverride]')).toHaveValue('PO Split remark </textarea><img src=x>');
    await expect(page.locator('[data-special-po-routing-form] [data-scm-field=notes]')).toHaveValue('Special request Note');
    await expect(page.locator('.scm-mini-panel img')).toHaveCount(0);
    assert.deepEqual(state.errors,[]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
    await page.screenshot({path:out+'/po-text-mobile.png',fullPage:true});
  } finally {await close();}
});

test('switching requests ignores a late routing response from the previous PO',async()=>{
  let release;
  const delayed=new Promise(resolve=>{release=resolve;});
  const {page,state,close}=await fixture(true,390,state=>{
    state.delays.set('TEST-PO',delayed);
    state.records.push({...state.record,id:2,requestRef:'SPREQ-SECOND',purchaseOrderRef:'SECOND-PO'});
    state.orders.set('SECOND-PO',{...state.order,id:'SECOND-PO',originalPoRef:'SECOND-PO',scm:{...state.order.scm,method:'Vendor'}});
  });
  try {
    await expect.poll(()=>state.reads.includes('TEST-PO')).toBe(true);
    await page.locator('.stock-request-card[data-id="2"]').click();
    await expect(page.locator('[data-special-po-routing-form] [data-scm-field=method]')).toHaveValue('Vendor');
    release();
    await expect(page.locator('.special-po-routing h3')).toContainText('SECOND-PO');
    await expect(page.locator('[data-special-po-routing-form] [data-scm-field=method]')).toHaveValue('Vendor');
    assert.deepEqual(state.errors,[]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
  } finally {release();await close();}
});

test('a mismatched catalog response cannot be edited and retry loads the matching PO',async()=>{
  const {page,state,close}=await fixture(true,1440,state=>{state.order.originalPoRef='WRONG-PO';});
  try {
    await expect(page.locator('.special-po-routing')).toContainText('does not match');
    await expect(page.locator('[data-special-po-routing-form]')).toHaveCount(0);
    state.order.originalPoRef='TEST-PO';
    await page.getByRole('button',{name:'Retry PO routing'}).click();
    await expect(page.locator('[data-special-po-routing-form]')).toBeVisible();
    assert.deepEqual(state.errors,[]);
  } finally {await close();}
});

test('special request routing loads the packing alias and saves the Note through its real request',async()=>{
  const {page,state,close}=await fixture(true,390,state=>{
    state.record.purchaseOrderReference='PACK-17';state.order.id='PACK-17';
    state.order.scm.packingSlipRef='PACK-17';
    state.orders.delete('TEST-PO');state.orders.set('PACK-17',state.order);
  });
  try {
    const form=page.locator('[data-special-po-routing-form]');
    await expect(form.locator('[data-scm-field=notes]')).toHaveValue('for SOB121819');
    await expect(page.locator('.special-po-routing a')).toHaveCount(0);
    await expect(form.locator('[data-scm-field=packingSlipRef]')).toHaveValue('PACK-17');
    await form.locator('[data-scm-field=notes]').fill('Shared renamed PO Note');
    await form.getByRole('button',{name:'Save Schedule',exact:true}).click();
    await expect.poll(()=>state.posts.length).toBe(1);
    assert.equal(state.posts[0].path,'/api/scm/special-stock-requests/1/purchase-order/routing');
    assert.equal(state.posts[0].body.expectedUpdatedAt,'2099-01-01T00:00:00.123456+00:00');
    assert.equal(state.posts[0].body.notes,'Shared renamed PO Note');
    assert.ok(state.reads.every(ref=>ref==='PACK-17'));
    assert.deepEqual(state.errors,[]);
  } finally {await close();}
});
