import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../../src/config.js';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {repairNetSuiteRecord} from '../../src/netsuite.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');after(closeDb);
test('the real NetSuite boundary permits master creation while blocking all financial writes with financial posting off',async t=>{
 const previous={repair:{...config.repair},url:config.netsuite.restBaseUrl,direct:config.netsuite.directAccessEnabled},writes=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.ok(String(url).startsWith('https://repair-master-test.invalid/'));writes.push({url:String(url),method:options.method});return new Response(null,{status:204});});
 try{config.repair={enabled:true,postingEnabled:false};config.netsuite.directAccessEnabled=true;config.netsuite.restBaseUrl='https://repair-master-test.invalid/services/rest';
  await withTransaction(async()=>{
   await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'isolated-test-token',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
   for(const type of ['customrecord240','customrecord_mrb_machine_master'])await repairNetSuiteRecord(type,null,{method:'POST',body:{externalId:'isolated-master'}});
   for(const type of ['salesOrder','vendorBill','customrecord_mbr_work_order','customrecord246','customrecord247'])await assert.rejects(repairNetSuiteRecord(type,null,{method:'POST',body:{}}),error=>error.status===409);
   await assert.rejects(repairNetSuiteRecord('customer',null,{method:'POST',body:{}}),/Unsupported/);
   config.repair.enabled=false;await assert.rejects(repairNetSuiteRecord('customrecord240',null,{method:'POST',body:{}}),error=>error.status===409);
   assert.equal(writes.length,2);assert.ok(writes.every(w=>w.method==='POST'));
  },{rollback:true});
 }finally{config.repair=previous.repair;config.netsuite.restBaseUrl=previous.url;config.netsuite.directAccessEnabled=previous.direct;}
});
