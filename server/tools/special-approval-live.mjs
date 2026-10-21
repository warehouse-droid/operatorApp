// Read-only live evidence. No order mutation or local case correction.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=process.cwd();
const {config}=await import(`${root}/src/config.js`);
const {query,closeDb}=await import(`${root}/src/db.js`);
const {getSpecialStockCase}=await import(`${root}/src/special-stock-request-repository.js`);
const {getNetSuiteM2mAccessToken}=await import(`${root}/src/netsuite-m2m-runtime.js`);
const token=await getNetSuiteM2mAccessToken();
const hash=record=>createHash('sha256').update(JSON.stringify({discountItem:record.discountItem,discountRate:record.discountRate,
  salesRep:record.salesRep,item:record.item.items.map(l=>({line:l.line,item:l.item,quantity:l.quantity,rate:l.rate,amount:l.amount,units:l.units,description:l.description}))})).digest('hex');
async function read(kind,id){
 const response=await fetch(`${config.netsuite.restBaseUrl}/record/v1/${kind}/${id}?expandSubResources=true`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
 assert.equal(response.status,200);return response.json();
}
try{
 const before=process.argv.includes('--before');
 const [so,po,d]=await Promise.all([read('salesOrder',1022888),read('purchaseOrder',1023378),getSpecialStockCase(67,{audience:'scm'})]);
 const sales=await getSpecialStockCase(67,{audience:'sales'});
 assert.equal(d.salesOrderRef,'SOM06738');assert.equal(d.purchaseOrderRef,'POB03960');assert.equal(d.attention,false);
 assert.equal(hash(so),'3fccd31f957d6f427d766251aaa39be16479311d577782f2b5c85e4229dfc14e');
 assert.equal(sales.fulfillmentMethod,d.fulfillmentMethod);assert.equal(sales.fulfillmentChangePlan,undefined);
 if(!before){
  assert.equal(d.purchaseOrderApproved,true);assert.equal(d.purchaseOrderPendingApproval,false);assert.equal(d.stage,'dispatch_arrangement');
  assert.equal(d.purchaseOrderReference,'');assert.equal(d.fulfillmentChange,null);
  const counts=(await query("SELECT (SELECT count(*) FROM special_stock_workflow_stages WHERE stage='confirmed')::integer AS confirmed,(SELECT count(*) FROM special_stock_purchase_approval WHERE pending)::integer AS pending")).rows[0];
  console.log(JSON.stringify({queueCounts:counts}));
 }
 console.log(JSON.stringify({readOnly:true,case:d.requestRef,stage:d.stage,fulfillmentMethod:d.fulfillmentMethod,purchaseOrderApproved:d.purchaseOrderApproved,
   purchaseOrderStatus:d.purchaseOrderStatus,salesOrderFinancialHash:hash(so),purchaseOrderFinancialHash:hash(po),purchaseOrderReference:d.purchaseOrderReference,
   deliveryMappingConfigured:Boolean(config.specialStock.deliveryMethodId),pickupMappingConfigured:Boolean(config.specialStock.pickupMethodId)}));
}finally{await closeDb();}
