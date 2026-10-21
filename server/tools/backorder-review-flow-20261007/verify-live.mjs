import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,closeDb} from '../../src/db.js';
import {getBackorderRequest} from '../../src/backorder-request-service.js';
import {createBackorderUI} from '../../public/backorder-stock-requests.js';
import {backorderStage,assertBackorderOrderLink} from '../../public/backorder-workflow.js';
try{
  assert.equal((await query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='270_backorder_order_completion.sql'")).rows[0].n,1);
  const render=(audience,detail)=>createBackorderUI({mount:{addEventListener(){}},audience,api:async()=>({vendors:[]}),getDetail:()=>detail,setDetail(){},render(){}}).detail(detail);
  const line={id:1,originalRate:null,quantity:1,uom:'EA',vendorName:'TEST vendor',vendorId:331,supplyStatus:'in_stock',stockCheckedAt:'2099-01-01',salesDecision:'pending'};
  const d={id:1,revision:1,requestRef:'STREQ-TEST',requestType:'regular',workflowKind:'backorder',workflowVersion:2,regular:{deliveryMethod:'backorder'},stage:'await_customer_confirmation',lines:[line],events:[],transfers:[],fulfillmentMethod:'yard_pickup'};
  assert.equal(render('sales',d).includes('data-action="sales-order/link"'),false);assert.equal(render('scm',d).includes('data-action="purchase-order/link"'),false);
  const scm=render('scm',d);assert.equal(scm.includes('name="unitPurchaseCost"'),false);assert.ok(scm.indexOf('data-action="information/request"')<scm.indexOf('<h3>Materials</h3>'));
  assert.throws(()=>assertBackorderOrderLink(d,'purchase_order'),{code:'BACKORDER_SALES_ACCEPTANCE_REQUIRED'});
  const accepted={...d,lines:[{...line,salesDecision:'accepted'}]};assert.equal(render('scm',accepted).includes('data-action="purchase-order/link"'),true);
  const purchasing={...accepted,purchaseOrderId:1};assert.throws(()=>assertBackorderOrderLink(purchasing,'sales_order'),{code:'BACKORDER_PO_PLANNING_REQUIRED'});
  assert.equal(render('sales',{...purchasing,dispatchPlanning:{purchaseOrder:{planned:true}}}).includes('data-action="sales-order/link"'),true);
  assert.equal(backorderStage({linesResolved:true,hasAcceptedLines:true}),'confirmed');assert.equal(backorderStage({linesResolved:true,hasAcceptedLines:false}),'closed');assert.equal(backorderStage({purchaseOrderId:1}),'dispatch_arrangement');assert.equal(backorderStage({salesOrderId:1}),'completed');
  for(const stage of ['new_enquiry','confirmed','dispatch_arrangement','closed','completed']){
    assert.ok(render('sales',{...d,stage,estimateNumber:'QUOT-LIVE-CHECK'}).includes('data-action="quotation/link"'));
    assert.equal(render('scm',{...d,stage,estimateNumber:'QUOT-LIVE-CHECK'}).includes('data-action="quotation/link"'),false);
  }
  const records=(await query("SELECT special.request_id,stage.stage FROM sales_special_stock_cases special JOIN special_stock_workflow_stages stage ON stage.request_id=special.request_id WHERE special.workflow_kind='backorder' ORDER BY special.request_id")).rows;
  for(const row of records)assert.equal((await getBackorderRequest(row.request_id,{audience:'scm'})).stage,row.stage);
  for(const role of ['sales','scm']){const response=await fetch('http://127.0.0.1:3000/'+role+'/stock-requests');assert.equal(response.status,200);assert.ok((await response.text()).includes('backorder=20261007-v3'));}
  for(const name of ['backorder-stock-requests.js','stock-request-queue-filter.js']){const response=await fetch('http://127.0.0.1:3000/'+name+'?v=20261007-v3');assert.equal(response.status,200);assert.equal(await response.text(),readFileSync('public/'+name,'utf8'));}
  console.log(JSON.stringify({liveReadOnlyVerification:true,migration270:true,reviewAcceptancePoPlanSoCompletion:true,requestInformationBeforeMaterials:true,noReviewPurchaseCost:true,multiSelectScmQueues:true,NetSuiteQuotationAtEveryStage:true,liveBackordersVerified:records.length,cacheVersion:'20261007-v3'}));
}finally{await closeDb();}
