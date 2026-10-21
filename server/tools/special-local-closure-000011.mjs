import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {query,closeDb} from '../src/db.js';
import {suiteqlAll} from '../src/netsuite.js';
import {withOperatorNetSuitePriority} from '../src/operator-netsuite-request-pool.js';
import {getSpecialStockCase} from '../src/special-stock-request-repository.js';
import {createSpecialClosureService} from '../src/special-stock-closure-service.js';
import {readSpecialClosedOrders} from '../src/special-stock-closed-orders.js';
const file='/tmp/special-local-closure-000011.private.json';
const reviewId='fed6cc19-0176-4fd9-947b-0657dfbca7f2';
const mode=process.argv.at(-1);assert.ok(['preflight','apply','verify'].includes(mode));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const closedOrders=detail=>readSpecialClosedOrders(detail,{queryAll:suiteqlAll},{allowFulfilledSalesOrder:true});
function identity(d) {
  assert.deepEqual([d.id,d.requestRef,d.salesOrderId,d.salesOrderRef,d.purchaseOrderId,d.purchaseOrderRef],
    [67,'SPREQ-000011',1022888,'SOM06738',1023378,'POB03960']);
  assert.equal(d.closureReview.id,reviewId);assert.ok(d.closureReview.confirmedAt && d.closureReview.confirmedBy);
  assert.equal(d.dispatchPlanning.anyPlanned,false);assert.equal(d.quantityReviewPending,false);
}
async function protectedHash() {
  return digest((await query(`SELECT to_jsonb(r) AS request,to_jsonb(c) AS special,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE l.request_id=r.id) AS lines,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_order_lines l WHERE l.request_id=r.id) AS orders
    FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id<>67 ORDER BY r.id`)).rows);
}
async function ownLinesHash() {
  return digest((await query(`SELECT
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=67) AS lines,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_order_lines l WHERE request_id=67) AS orders`)).rows);
}
async function checkedEvidence(d) {
  const evidence=await closedOrders(d);assert.ok(evidence);
  const so=evidence.orders.find(o=>o.kind==='sales_order'),po=evidence.orders.find(o=>o.kind==='purchase_order');
  assert.equal(so.status,'F');assert.equal(so.statusText,'Sales Order : Pending Billing');assert.equal(so.fullyFulfilled,true);
  assert.equal(po.status,'H');assert.equal(po.statusText,'Purchase Order : Closed');
  assert.deepEqual(so.fulfillmentLines.map(l=>l.remoteLineId).sort((a,b)=>a-b),d.salesOrderLines.map(l=>l.remoteLineId).sort((a,b)=>a-b));
  assert.equal(so.fulfillmentLines.length,6);return evidence;
}
try {await withOperatorNetSuitePriority(async()=>{
  const detail=await getSpecialStockCase(67,{audience:'scm'});identity(detail);
  if(mode==='preflight') {
    assert.equal(existsSync(file),false,'Preserve the existing checkpoint');
    assert.equal(detail.closeStatus,'closure_pending');assert.equal(detail.closureReview.status,'attention');
    const evidence=await checkedEvidence(detail);
    writeFileSync(file,JSON.stringify({detail,evidence,protectedHash:await protectedHash(),ownLinesHash:await ownLinesHash()},null,2),{mode:0o600,flag:'wx'});
    return console.log(JSON.stringify({prepared:true,request:'SPREQ-000011',salesOrderStatus:'Pending Billing',purchaseOrderStatus:'Closed',netSuiteWrites:0}));
  }
  const checkpoint=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(await protectedHash(),checkpoint.protectedHash);assert.equal(await ownLinesHash(),checkpoint.ownLinesHash);
  assert.deepEqual(await checkedEvidence(detail),checkpoint.evidence);
  if(mode==='apply' && detail.closeStatus!=='closed') {
    assert.equal(detail.revision,checkpoint.detail.revision);
    const service=createSpecialClosureService({readClosedOrders:closedOrders,
      preparePlan:async()=>assert.fail('Local-only recovery must not create a NetSuite plan'),
      applyPlan:async()=>assert.fail('No NetSuite order mutation is authorized')});
    await service.reviewClosure(67,{decision:'approve',reviewId,expectedRevision:detail.revision},
      {operatorId:null,allowFulfilledSalesOrder:true});
  }
  const after=await getSpecialStockCase(67,{audience:'scm'});identity(after);
  assert.equal(after.closeStatus,'closed');assert.equal(after.status,'cancelled');assert.equal(after.closureReview.status,'approved');
  assert.equal(after.closureReview.localOnly,true);assert.equal(after.closureReview.confirmedBy,checkpoint.detail.closureReview.confirmedBy);
  assert.equal(after.salesOrderStatus,'Sales Order : Pending Billing');assert.equal(after.purchaseOrderStatus,'Purchase Order : Closed');
  assert.equal(await protectedHash(),checkpoint.protectedHash);assert.equal(await ownLinesHash(),checkpoint.ownLinesHash);
  assert.deepEqual(await checkedEvidence(after),checkpoint.evidence);
  const result={verified:true,request:'SPREQ-000011',localCloseStatus:after.closeStatus,localRequestStatus:after.status,
    salesOrder:{reference:after.salesOrderRef,status:after.salesOrderStatus},purchaseOrder:{reference:after.purchaseOrderRef,status:after.purchaseOrderStatus},
    originalConfirmationRetained:true,otherRequestsUnchanged:true,commercialLinesUnchanged:true,netSuiteWrites:0};
  writeFileSync('/tmp/special-local-closure-000011-result.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
});} finally {await closeDb();}
