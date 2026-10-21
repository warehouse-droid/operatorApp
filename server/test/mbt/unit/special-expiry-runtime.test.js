import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpecialExpiryRuntime} from '../../../src/special-stock-expiry.js';
import {verifySpecialRestSalesOrder} from '../../../src/special-stock-rest-orders.js';
test('expiry runtime suppresses overlap, emits only completed changes and recovers from errors',async()=>{
 let release;const barrier=new Promise(resolve=>{release=resolve;});let calls=0;const events=[],errors=[];
 const runtime=createSpecialExpiryRuntime({expire:async()=>{calls++;if(calls===1){await barrier;return [1,2];}if(calls===2)throw Error('db failed');return [];},emit:ids=>events.push(ids),logger:{error:(...message)=>errors.push(message)}});
 const first=runtime.tick();await runtime.tick();assert.equal(calls,1);release();await first;assert.deepEqual(events,[[1,2]]);
 await runtime.tick();assert.equal(errors.length,1);await runtime.tick();assert.equal(calls,3);assert.equal(events.length,1);
 runtime.stop();
});
test('native readback rejects dropped or changed pack fields, while legacy unspecified fields remain compatible',async()=>{
 const line={item:{id:'2055'},line:1,lineUniqueKey:'1001',quantity:24,rate:10,units:'865',description:'Stone',custcol_plt:2,custcol_lyr:0,custcol_sec:3,custcol_pcs:4};
 const payload={entity:{id:'2'},location:{id:'1'},item:{items:[{...line}]}};
 const remote={entity:{id:'2'},location:{id:'1'},item:{items:[{...line}]}};
 const transport={rest:async()=>({data:remote}),queryAll:async()=>[{rest_line_id:1,uniquekey:1001,item:2055,status:'B',execution_quantity:0,billed_quantity:0,line_closed:'F'}]};
 await verifySpecialRestSalesOrder(10,payload,transport);
 remote.item.items[0].custcol_pcs=5;
 await assert.rejects(()=>verifySpecialRestSalesOrder(10,payload,transport),{code:'SPECIAL_SO_PRICE_CONFLICT'});
 delete payload.item.items[0].custcol_pcs;await verifySpecialRestSalesOrder(10,payload,transport);
});
test('expiry timer starts once, runs immediately and can be stopped',async()=>{
 let calls=0,resolve;const second=new Promise(done=>{resolve=done;});
 const runtime=createSpecialExpiryRuntime({intervalMs:10,expire:async()=>{calls++;if(calls===2)resolve();return [];}});
 const keepAlive=setTimeout(resolve,1000);
 try{runtime.start();runtime.start();await second;runtime.stop();assert.equal(calls,2);runtime.stop();}
 finally{clearTimeout(keepAlive);runtime.stop();}
});
