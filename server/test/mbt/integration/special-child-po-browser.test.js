/* global localStorage */
import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {createSpecialStockCase,getSpecialStockCase} from '../../../src/special-stock-request-repository.js';
import {createScmPurchaseOrderSplit,listScmPurchaseOrders} from '../../../src/dispatch-repository.js';
import {upsertScmPurchaseOrderCatalog} from '../../../src/scm-purchase-order-catalog-repository.js';
import {createSpecialOrderDocumentService} from '../../../src/special-stock-documents.js';
import {listSpecialPoReferenceAlerts} from '../../../src/special-po-reference-alerts.js';

let server,browser;
after(async()=>{
  await browser?.close();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await closeDb();
});

test('SCM attaches one child and saves its routing through the real browser and HTTP API',async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  const scm=await createOperator({username:'test-child-browser',displayName:'TEST SCM',password:'test-only-child-browser',role:'scm',roles:['scm'],yardLocationIds:[1]});
  const detail=await createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST child browser',vendorId:330,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',lines:[{productName:'Richmond Grey',quantity:1968,uom:'SQFT',rate:5,requiredDate:'2099-01-02'}]},{operatorId:scm.id,authorizedStoreLocationIds:[1]});
  const parent=887701001,ref='TEST-BROWSER-POB03429';
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,vendor,status,status_text,netsuite_active,destination_location_id,destination_location,netsuite_note) VALUES($1,$2,330,'TEST Vendor','D','Purchase Order : Partially Received',true,1,'3445','Shared source note')",[parent,ref]);
  const line=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,sku,item_name,item_description,quantity,unit,netsuite_active,netsuite_received_baseline_qty) VALUES($1,1,2055,'MBBS-Special Order','MBBS-Special Order','Richmond 80mm Grey Mix',6000,'SQFT',true,0) RETURNING id",[parent])).rows[0];
  const children=[];
  for(const [suffix,quantity] of [['L3-18Plt',1771.2],['L4',1968]]) {
    children.push((await createScmPurchaseOrderSplit({sourcePoRef:ref,newPoRef:`${ref} (${suffix})`,destinationLocationId:1,lines:[{lineRowId:line.id,salesQty:quantity}],createdBy:scm.id})).split);
  }
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active) VALUES(887701002,'TEST-BROWSER-SO','B','Pending Fulfillment',true)");
  await query("UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=$2,purchase_order_ref=$3,purchase_order_custom_linkage=true,sales_order_source='manual_link',purchase_order_operation_status='linked',sales_order_netsuite_id=887701002,sales_order_ref='TEST-BROWSER-SO',sales_order_operation_status='linked' WHERE request_id=$1",[detail.id,parent,ref]);
  await upsertScmPurchaseOrderCatalog({orders:await listScmPurchaseOrders({search:ref}),source:'test-child-browser'});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:scm.username,password:'test-only-child-browser'})});
  assert.equal(login.status,200);const {token}=await login.json();
  const path=`/api/scm/special-stock-requests/${detail.id}/purchase-order/`;
  assert.equal((await fetch(base+path+'splits')).status,401);
  const before=(await query('SELECT * FROM scm_transport_schedule WHERE order_ref=$1',[children[0].splitPoRef])).rows;
  browser=await chromium.launch({args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),token);
  const page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[],saves=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='PUT' && request.url().endsWith('/purchase-order/routing')) {saves.push(request.postDataJSON());}});
  await page.goto(base+`/scm/stock-requests?tab=special&requestId=${detail.id}`);
  await expect(page.locator('[data-special-po-split-form]')).toBeVisible();
  await page.getByLabel('Attached PO',{exact:true}).selectOption(String(children[1].id));
  await page.getByRole('button',{name:'Attach selected PO',exact:true}).click();
  const form=page.locator('[data-special-po-routing-form]');
  await expect(form).toContainText('Saved to this child PO.');
  await expect(form.locator('[name=packingSlipRef]')).toHaveAttribute('readonly','');
  await expect(page.getByLabel('Attached PO',{exact:true})).toHaveValue(String(children[1].id));
  await form.locator('[name=method]').selectOption('Vendor');
  await form.locator('[name=notes]').fill('Only collect this child');
  await form.getByRole('button',{name:'Save Schedule',exact:true}).click();
  await expect.poll(async()=> (await query('SELECT notes FROM scm_transport_schedule WHERE order_ref=$1',[children[1].splitPoRef])).rows[0]?.notes).toBe('Only collect this child');
  assert.deepEqual((await query('SELECT * FROM scm_transport_schedule WHERE order_ref=$1',[children[0].splitPoRef])).rows,before);
  assert.equal((await query('SELECT netsuite_note FROM purchase_orders WHERE netsuite_id=$1',[parent])).rows[0].netsuite_note,'Shared source note');
  assert.equal((await query('SELECT dispatch_ref FROM purchase_orders WHERE netsuite_id=$1',[children[1].splitPoId])).rows[0].dispatch_ref,children[1].splitPoRef);
  const selected=await getSpecialStockCase(detail.id,{audience:'scm',dispatchPlans:[]});
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const note=await fetch(base+path+'note',{headers});assert.equal(note.status,200);assert.equal((await note.json()).note,'Only collect this child');
  assert.equal((await fetch(base+path+'routing',{method:'PUT',headers,body:JSON.stringify(saves[0])})).status,409);
  const alerts=await listSpecialPoReferenceAlerts({audience:'dispatch',operatorId:scm.id});
  assert.equal(alerts.alerts.find(alert=>alert.requestId===detail.id).displayRef,children[1].splitPoRef);
  const preview=createSpecialOrderDocumentService({fetchPdf:async(kind,id)=>{assert.equal(kind,'purchase_order');assert.equal(id,parent);return{buffer:Buffer.from('%PDF-1.4\nTEST NATIVE PO'),filename:'POB03429.pdf'};}});
  assert.equal((await preview.preview(selected.id,'purchase_order',{audience:'scm'})).buffer.subarray(0,5).toString(),'%PDF-');
  const competing=await Promise.all([null,children[0].id].map(purchaseOrderSplitId=>fetch(base+path+'link',{
    method:'POST',headers,body:JSON.stringify({expectedRevision:selected.revision,purchaseOrderSplitId})
  })));
  assert.deepEqual(competing.map(response=>response.status).sort(),[200,409]);
  assert.equal((await getSpecialStockCase(detail.id,{audience:'scm',dispatchPlans:[]})).revision,selected.revision+1);
  assert.deepEqual(errors,[]);
  await context.close();
});
