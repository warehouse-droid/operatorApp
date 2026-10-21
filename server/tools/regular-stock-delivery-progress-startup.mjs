// Boot the actual runtime in the disposable database; no NetSuite work is sent.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {config} from '../src/config.js';
import {query} from '../src/db.js';
import {enqueueDeliveryOperation,getDeliveryOperation} from '../src/regular-stock-delivery-operations.js';
import {startServer} from '../src/server.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(config.netsuite.directAccessEnabled,false);
const actor='delivery-startup-'+randomUUID(),context={operatorId:actor,audience:'sales',authorizedDestinationLocationIds:[28]};
await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active,yard_location_ids) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true,ARRAY[28])",[actor]);
const op=await enqueueDeliveryOperation({operationId:randomUUID(),action:'preview',input:{salesOrderRef:''}},context);
config.port=0;
const server=await startServer();if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/health`)).status,200);
let result;
for(let i=0;i<100;i++){
 result=await getDeliveryOperation(op.id,context);if(result.status==='failed')break;
 await new Promise(resolve=>setTimeout(resolve,50));
}
assert.equal(result.status,'failed');assert.equal(result.code,'REGULAR_SO_REQUIRED');
console.log('Delivery startup worker consumed queued work; health=200; NetSuite calls=0');
process.exit(0);
