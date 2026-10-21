import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {closeDb} from '/app/src/db.js';
import {createOperator} from '/app/src/auth-repository.js';
import {buildOperatorNetSuitePostingDraft as draft} from '/app/src/operator-netsuite-posting-domain.js';
import {createOrReplayOperatorNetSuitePostingCommand as create,getOperatorNetSuitePostingCommand as get} from '/app/src/operator-netsuite-posting-repository.js';
import {verifyOperatorNetSuitePostingRecord as verify} from '/app/src/operator-netsuite-posting-adapter.js';
test('database persists non-inventory evidence and replay rejects changed UOM',async()=>{
 try {
 const requestId=crypto.randomUUID(),localOrderKey='customer_pickup:sales_order:1023363:'+requestId;
 const actor=await createOperator({username:'uom-'+requestId,displayName:'UOM check',password:'only-isolated-db',role:'operator',roles:['operator'],yardLocationIds:[1]});
 const input={requestId,actorOperatorId:actor.id,functionKey:'customer_pickup',transactionType:'IF',policy:{gateKey:'operator_netsuite_customer_pickup_if_3445',revision:1,effective:true,functionKey:'customer_pickup',transactionType:'IF',locationId:1,yardCode:'3445'},localOrderKeys:[localOrderKey],localOperation:{kind:'customer_pickup_load',orderId:'1023363',orderType:'sales_order'},targets:[{sourceOrderKind:'SO',sourceNetSuiteId:1023363,sourceOrderRef:'SOA09472',availableLines:[{orderLine:1,location:1}],selectedLines:[{orderLine:1,quantity:209.82,location:1,itemId:5175,localOrderKey,localLineId:'488722'}],confirmedNonInventoryLines:[{orderLine:2,quantity:58.59,location:1,itemId:2055,salesUom:'EACH',autoIncludedNonInventory:true,localOrderKey,localLineId:'488723',sourceLineKey:'5041424'}]}]};
 const prepared=draft(input);await create(prepared);const saved=await get(requestId);
 assert.deepEqual(saved.steps[0].lineSnapshot,prepared.steps[0].lineSnapshot);
 assert.equal(verify(saved.steps[0],{id:1035754,tranId:'IF156345',createdFrom:{id:1023363},externalId:saved.steps[0].externalId,transactionType:'IF',item:{items:[{orderLine:1,item:{id:5175},quantity:209.82,location:{id:1}},{orderLine:2,item:{id:2055},quantity:58.59,unitsDisplay:'EACH',location:{id:1}}]}}).id,1035754);
 assert.equal((await create(prepared)).replayed,true);
 input.targets[0].confirmedNonInventoryLines[0].salesUom='SQFT';await assert.rejects(create(draft(input)),e=>e.code==='OPERATOR_NETSUITE_POSTING_IDEMPOTENCY_CONFLICT');
 } finally {await closeDb();}
});
