import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
const {verifyOperatorNetSuitePostingRecord:verify}=await import(process.env.REVIEW_ADAPTER_SOURCE||'/app/src/operator-netsuite-posting-adapter.js');
const {buildOperatorNetSuitePostingDraft:draft}=await import(process.env.REVIEW_DOMAIN_SOURCE||'/app/src/operator-netsuite-posting-domain.js');
const {createOperatorNetSuitePostingTargetResolver,createOperatorNetSuitePostingRealSourceResolver}=await import(process.env.REVIEW_TARGETS_SOURCE||'/app/src/operator-netsuite-posting-targets.js');
const requestId='300a2177-ca79-4246-a1a2-b118715da5fd';
const inventory={id:488722,line_id:5041423,netsuite_order_line:1,item_id:5175,item_type:'InvtPart',unit:'SQFT',quantity:209.82,packed_sales_qty:209.82,location_id:1,confirmed:true};
const special={id:488723,line_id:5041424,netsuite_order_line:2,item_id:2055,item_type:'NonInvtPart',unit:'EACH',quantity:58.59,packed_sales_qty:58.59,location_id:1,confirmed:true};
async function make(lines=[inventory,special],kitMode=false){
 const order={netsuite_id:1023363,tranid:'SOA09472',order_type:'sales_order',delivery_method:'Pick-Up',outbound_location_id:1,operator_status:'packed',lines};
 const resolveRealSource=createOperatorNetSuitePostingRealSourceResolver({useStoredOrderLines:true,fetchPickupSource:null,fetchKitSource:async()=>({kitGroups:[],availableLines:[{orderLine:1,sourceLineKey:'5041423',sourceLineAliases:['5041423'],itemId:5175,location:1,orderedQuantity:209.82,remainingQuantity:209.82}]}),query:async()=>({rows:[...lines.map(l=>({...l,source_line_key:String(l.line_id),cached_completed_qty:0})),...(kitMode?[{item_type:'Kit',source_line_key:'999'}]:[])]})});
 const resolve=createOperatorNetSuitePostingTargetResolver({getDeliveryOrder:async()=>order,resolveRealSource});
 const target=await resolve({functionKey:'customer_pickup',orderId:1023363,clientLocationId:1});
 return draft({...target,requestId,actorOperatorId:'operator-one',policy:{gateKey:'operator_netsuite_customer_pickup_if_3445',revision:1,effective:true,functionKey:'customer_pickup',transactionType:'IF',locationId:1,yardCode:'3445'}});
}
function record(step,{quantity=58.59,unit='EACH',item=2055,location=1}={}){return {id:1035754,tranId:'IF156345',createdFrom:{id:1023363},externalId:step.externalId,transactionType:'IF',item:{items:[{orderLine:1,quantity:209.82,item:{id:5175},location:{id:1},unitsDisplay:'SQFT'}, {orderLine:2,quantity,item:{id:item},location:{id:location},unitsDisplay:unit}]}};}
function storedStep(d){return {...d.steps[0],lineSnapshot:JSON.parse(JSON.stringify(d.steps[0].lineSnapshot))};}
test('SOA09472 matching confirmed sales quantity and UOM pass after snapshot persistence',async()=>{
 const d=await make(),step=storedStep(d);
 assert.deepEqual(step.payload.item.items,[{orderLine:1,quantity:209.82,itemReceive:true,location:1}]);
 assert.equal(verify(step,record(step)).transactionRef,'IF156345');
 assert(d.steps[0].lineSnapshot.some(l=>l.autoIncludedNonInventory&&l.salesUom==='EACH'&&l.quantity===58.59));
 const changed=await make([inventory,{...special,unit:'SQFT'}]);assert.notEqual(d.inputHash,changed.inputHash);
});
test('omitted optional NonInvtPart does not require review',async()=>{const step=storedStep(await make()),r=record(step);r.item.items.pop();assert.equal(verify(step,r).id,1035754);});
test('actual mismatches and unconfirmed lines stay held',async()=>{
 const step=storedStep(await make());
 for(const change of [{quantity:58.95},{unit:'SQFT'},{unit:''},{item:1784},{location:28},{quantity:NaN}])assert.throws(()=>verify(step,record(step,change)),{code:'OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH'});
 for(const change of [{confirmed:false},{packed_sales_qty:0},{netsuite_order_line:null},{unit:''}]){const s=storedStep(await make([inventory,{...special,...change}]));assert.throws(()=>verify(s,record(s)),{code:'OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH'});}
 for(const mutate of [r=>r.externalId+='x',r=>r.createdFrom.id=1,r=>r.item.items.push({...r.item.items[1]}),r=>r.item.items[1].orderLine=3,r=>r.item.items.shift()]){const r=record(step);mutate(r);assert.throws(()=>verify(step,r),{code:'OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH'});}
});
test('non-inventory sales quantities are order invariant and never accepted with a changed UOM',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:1,max:100000}),async cents=>{const q=cents/100;const d=await make([inventory,{...special,quantity:q,packed_sales_qty:q}]);const s=storedStep(d),r=record(s,{quantity:q});r.item.items.reverse();assert.equal(verify(s,r).id,1035754);assert.throws(()=>verify(s,record(s,{quantity:q,unit:'Yard'})));assert.throws(()=>verify(s,record(s,{quantity:q+0.01})));const unconfirmed=storedStep(await make([inventory,{...special,quantity:q,packed_sales_qty:q,confirmed:false}]));assert.throws(()=>verify(unconfirmed,record(unconfirmed,{quantity:q})));}),{numRuns:50,seed:20261003});
});

test('a standalone special line can match alongside kit-aware source resolution',async()=>{const s=storedStep(await make([inventory,special],true));assert.equal(verify(s,record(s)).id,1035754);});
