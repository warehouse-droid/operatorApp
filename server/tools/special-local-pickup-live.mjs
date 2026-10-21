// Recover only the user's saved, unplanned pickup-location change. NetSuite access is GET-only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=process.cwd();
const {config}=await import(root+'/src/config.js');
const {query,closeDb}=await import(root+'/src/db.js');
const {getSpecialStockCase}=await import(root+'/src/special-stock-request-repository.js');
const {getNetSuiteM2mAccessToken}=await import(root+'/src/netsuite-m2m-runtime.js');
const expectedChange='4129faee-4263-4ec4-a369-d85641520482';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const financial=record=>({discountItem:record.discountItem,discountRate:record.discountRate,salesRep:record.salesRep,
  item:record.item.items.map(l=>({line:l.line,item:l.item,quantity:l.quantity,rate:l.rate,amount:l.amount,units:l.units,description:l.description}))});
const headers=record=>({method:record.custbody3,date:record.custbody4,notes:record.custbody7,address:record.shippingAddress,shipAddress:record.shipAddress});
async function nativeEvidence() {
 const token=await getNetSuiteM2mAccessToken();
 async function read(kind,id) {
  const response=await fetch(config.netsuite.restBaseUrl+'/record/v1/'+kind+'/'+id+'?expandSubResources=true',
    {method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'}});
  assert.equal(response.status,200);return response.json();
 }
 const [so,po]=await Promise.all([read('salesOrder',1022888),read('purchaseOrder',1023378)]);
 assert.equal(Number(so.custbody3?.id),Number(config.specialStock.pickupMethodId));
 return {salesOrderFinancialHash:hash(financial(so)),purchaseOrderFinancialHash:hash(financial(po)),salesOrderDeliveryHash:hash(headers(so))};
}
async function localEvidence() {
 return (await query(`SELECT delivery_method_id,sales_order_type,expected_delivery_date,dispatch_address,
   dispatch_window_start,dispatch_window_end,dispatch_instructions FROM sales_orders WHERE netsuite_id=1022888`)).rows[0];
}
try {
 const before=await getSpecialStockCase(67,{audience:'scm'});
 assert.equal(before.requestRef,'SPREQ-000011');assert.equal(before.salesOrderRef,'SOM06738');assert.equal(before.purchaseOrderRef,'POB03960');
 assert.equal(before.fulfillmentChange?.id,expectedChange);assert.equal(before.fulfillmentChange.target.fulfillmentMethod,'vendor_pickup');
 const remoteBefore=await nativeEvidence(),localBefore=await localEvidence();
 if(!process.argv.includes('--recover')) {
  console.log(JSON.stringify({readOnly:true,case:before.requestRef,current:before.fulfillmentMethod,target:before.fulfillmentChange.target.fulfillmentMethod,
    changeStatus:before.fulfillmentChange.status,remotePlanPresent:Boolean(before.fulfillmentChangePlan),...remoteBefore}));
 } else {
  assert.equal(before.fulfillmentMethod,'yard_pickup');assert.equal(before.fulfillmentChange.status,'attention');assert.equal(before.fulfillmentChangePlan,null);
  assert.equal(before.dispatchPlanning?.anyPlanned,false);
  const {createSpecialFulfillmentService}=await import(root+'/src/special-stock-fulfillment.js');
  const update=createSpecialFulfillmentService({prepare:()=>assert.fail('Recovery must not prepare a NetSuite update'),apply:()=>assert.fail('Recovery must not write to NetSuite')});
  const detail=await update(67,{expectedRevision:before.revision,changeId:expectedChange},
    {operatorId:before.fulfillmentChange.requestedBy,authorizedStoreLocationIds:[before.storeLocationId]});
  assert.equal(detail.fulfillmentMethod,'vendor_pickup');assert.equal(detail.fulfillmentChange.status,'complete');assert.equal(detail.fulfillmentChange.error,null);
  assert.equal(detail.attention,false);assert.deepEqual(await localEvidence(),localBefore);
  const remoteAfter=await nativeEvidence();assert.deepEqual(remoteAfter,remoteBefore);
  const scm=await getSpecialStockCase(67,{audience:'scm'});assert.equal(scm.fulfillmentMethod,'vendor_pickup');assert.equal(scm.handoff,null);
  console.log(JSON.stringify({recovered:true,case:detail.requestRef,fulfillmentMethod:detail.fulfillmentMethod,changeStatus:detail.fulfillmentChange.status,
    attention:detail.attention,netSuiteWrites:0,canonicalOrderHeadersUnchanged:true,...remoteAfter}));
 }
} finally {await closeDb();}
