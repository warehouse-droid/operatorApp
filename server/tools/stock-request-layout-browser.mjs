import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const out='/app/test-artifacts/stock-request-cleanup-layout';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
const yards=[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'3551'},{locationId:15,yardCode:'Other yard'}];
const fixture=(id,yard)=>({id,requestRef:`SPREQ-TEST-${id}`,revision:1,storeLocationId:yard,storeName:yards.find(y=>y.locationId===yard).yardCode,stage:'new_enquiry',customerName:'TEST Customer',vendorName:'TEST Vendor',closeStatus:'active',fulfillmentMethod:'yard_pickup',inquiryDate:'2099-01-01',lines:[{id,productName:'TEST Material',quantity:2,uom:'PCS',rate:100,salesDecision:'pending'}],salesOrderLines:[],purchaseOrderLines:[],events:[],media:[],readinessAlerts:[]});
const results=[],errors=[];
try {
 for(const role of ['sales','scm']) for(const width of [1440,768,390]) {
  const context=await browser.newContext({viewport:{width,height:960}});
  const login=await context.request.post('http://127.0.0.1:3000/api/auth/login',{data:{username:`review-${role}`,password:'SpecialReview-2026!'}}); // secret-scan: allow -- disposable review account
  assert.equal(login.status(),200); const {token}=await login.json();
  await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);window.EventSource=class extends EventTarget{close(){}};},token);
  const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  const cases=[fixture(1,1),{...fixture(2,28),salesOrderId:1017268,salesOrderRef:'SOB121381',salesOrderStatus:'Closed',closeStatus:'closed',stage:'closed'},
    {...fixture(3,15),salesOrderId:1017068,salesOrderRef:'SOB121380',purchaseOrderId:1017168,purchaseOrderRef:'POB03934',salesOrderStatus:'Closed',purchaseOrderStatus:'Closed',closeStatus:'closed',stage:'closed'}];
  let calls=0,detailCalls=0; const regularQueries=[];
  await page.route(`**/api/${role}/special-stock-requests**`,route=>{
    const url=new URL(route.request().url()),path=url.pathname.split('/special-stock-requests')[1];
    assert.equal(route.request().method(),'GET');
    if(path==='/policy')return route.fulfill({json:{enabled:true}});
    if(path.endsWith('.pdf'))return route.fulfill({contentType:'application/pdf',body:'%PDF-1.4\n%%EOF'});
    if(!path){calls++;const selected=(url.searchParams.get('storeLocationIds')||'').split(',').filter(Boolean).map(Number);return route.fulfill({json:{yards,requests:cases.filter(row=>!selected.length||selected.includes(row.storeLocationId))}});}
    detailCalls++;return route.fulfill({json:cases.find(row=>row.id===Number(path.slice(1)))});
  });
  await page.route(`**/api/${role}/stock-requests?**`,route=>{regularQueries.push(new URL(route.request().url()).searchParams);return route.fulfill({json:{yards,requests:[],filterOptions:{vendors:['TEST Vendor'],sourceYards:yards,destinationYards:yards}}});});
  await page.goto(`http://127.0.0.1:3000/${role}/stock-requests`);
  await page.locator('.stock-request-card').first().waitFor();
  assert.equal(calls,1);assert.equal(detailCalls,0);
  const search=role==='sales'?'[data-special-search]':'[data-special-scm-search]';
  if(width===1440){const boxes=await page.locator(`${search}, .stock-request-yard-filter > summary, .special-stage-filter > summary`).evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().y));assert.ok(Math.max(...boxes)-Math.min(...boxes)<8,'Special search and filters must share one row');}
  await page.locator('.stock-request-yard-filter > summary').click();
  await page.locator('[data-special-yard][value="1"]').check();
  await page.waitForFunction(()=>document.querySelectorAll('.stock-request-card').length===1);
  await page.locator('[data-special-yard][value="28"]').check();
  await page.waitForFunction(()=>document.querySelectorAll('.stock-request-card').length===2);
  assert.equal(await page.locator('[data-special-yard]:checked').count(),2);
  await page.locator('[data-yard-filter-clear="storeLocationIds"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.stock-request-card').length===3);
  const before=calls;
  for(const id of [2,3,1]){
    await page.locator(`.stock-request-card[data-id="${id}"]`).click();
    assert.equal(detailCalls,0);assert.equal(calls,before);
    if(role==='sales') {
      assert.equal(await page.getByRole('heading',{name:'Case lines',exact:true}).count(),id===1?1:0);
      assert.equal(await page.locator('[data-special-document="purchase_order"]').count(),0);
      if(id!==1){
        assert.equal(await page.locator('.stock-request-detail > .stock-request-summary + .special-sales-order-documents').count(),1);
        const refs=await page.locator('.special-sales-order-documents').innerText();
        assert.match(refs,new RegExp(cases[id-1].salesOrderRef));
        if(id===3) assert.match(refs,/POB03934/);
        assert.equal(await page.locator('[data-special-document="sales_order"]').count(),1);
        await page.locator('[data-special-document="sales_order"]').click();await page.locator('.special-document-dialog iframe').waitFor();await page.locator('[data-document-close]').click();
      }
    } else if(id===3) {
      assert.equal(await page.locator('.special-planning-status [data-special-document="sales_order"]').count(),1);
      assert.equal(await page.locator('.special-planning-status [data-special-document="purchase_order"]').count(),1);
    }
  }
  await page.locator('.stock-request-card[data-id="3"]').click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Special mobile overflow');
  await page.screenshot({path:`${out}/special-${role}-${width}.png`});
  await page.locator(role==='sales'?'[data-special-sales-action=regular]':'[data-stock-request-tab=regular]').click();
  await page.locator('[data-yard-filter="sourceLocationId"] > summary').waitFor();
  if(width===1440){const bottoms=await page.locator(`.stock-request-search, .stock-request-filters > label > input, .stock-request-filters > label > select, .stock-request-filters summary`).evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().bottom));assert.ok(Math.max(...bottoms)-Math.min(...bottoms)<12,'Regular search and filters must share one row');}
  for(const name of (role==='sales'?['sourceLocationId']:['sourceLocationId','destinationLocationId'])) {
    await page.locator(`[data-yard-filter="${name}"] > summary`).click();
    for(const id of [1,28]){await page.locator(`input[name="${name}"][value="${id}"]`).check();await page.waitForFunction(({name,id})=>document.querySelector(`[data-yard-filter="${name}"]`)?.open&&document.querySelector(`input[name="${name}"][value="${id}"]`)?.checked,{name,id});}
    assert.equal(regularQueries.at(-1).get(`${name}s`),'1,28');
    await page.locator(`[data-yard-filter-clear="${name}"]`).click();
    await page.waitForFunction(name=>!document.querySelector(`input[name="${name}"]:checked`),name);
    assert.equal(regularQueries.at(-1).get(`${name}s`),null);
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Regular mobile overflow');
  await page.screenshot({path:`${out}/regular-${role}-${width}.png`});
  await writeFile(`${out}/browser-coverage-${role}-${width}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));
  results.push({role,width,multiYard:true,caseLinesAndOrders:true,cardsUseLoadedData:true});await context.close();
 }
 assert.deepEqual(errors,[]);
 const sourceHashes={};for(const file of ['public/stock-request-yard-filter.js','public/stock-requests.css','public/sales-special-stock-requests.js','public/scm-special-stock-requests.js','public/sales-stock-requests.js','public/scm-stock-requests.js'])sourceHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
 await writeFile(`${out}/browser.json`,JSON.stringify({results,errors,sourceHashes},null,2));console.log(JSON.stringify(results));
} finally {await browser.close();}
