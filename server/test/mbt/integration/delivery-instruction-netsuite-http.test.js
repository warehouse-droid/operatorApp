import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomInt,randomUUID} from 'node:crypto';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import {config} from '../../../src/config.js';
import {app} from '../../../src/server.js';
import {isOperatorNetSuiteRequest} from '../../../src/operator-netsuite-request-pool.js';
const id=9_760_000_000+randomInt(100000000),ref='DI-HTTP-'+randomUUID().slice(0,8),tokens={},calls=[];
const record={id:String(id),tranId:ref,location:{id:'1'},custbody3:{id:'2'},status:{id:'B'},custbody7:'Old note',shipDate:'2026-10-01',custbody4:'2026-10-02'};
let server,base;const originalFetch=globalThis.fetch,originalConfig={...config.netsuite};
async function http(path,role,body){
 const response=await fetch(base+path,{method:body===undefined?'GET':'PUT',headers:{...(role?{Authorization:`Bearer ${tokens[role]}`}:{ }),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return{status:response.status,headers:response.headers,body:await response.json()};
}
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 for(const [key,role,yards]of[['sales','sales',[1]],['other','sales',[28]],['dispatch','dispatcher',[]]]){
  const username=`di-ns-${key}-${randomUUID()}`;
  await createOperator({username,displayName:username,password:'Disposable-Instruction-2026!',role,roles:[role],yardLocationIds:yards});
  const res=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'Disposable-Instruction-2026!'})});
  tokens[key]=(await res.json()).token;assert(tokens[key]);
 }
 await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,order_location_id,sales_order_type,memo,netsuite_active,synced_at)
 VALUES($1,$2,current_date,'Test customer','Pending Fulfillment','Pending Fulfillment',1,'Delivery','Old note',true,now())`,[id,ref]);
 await query("INSERT INTO netsuite_tokens(id,access_token,expires_at)VALUES(1,'isolated-delivery-test',now()+interval '1 day') ON CONFLICT(id)DO UPDATE SET access_token='isolated-delivery-test',expires_at=now()+interval '1 day'");
 Object.assign(config.netsuite,{directAccessEnabled:true,restBaseUrl:'https://delivery-instruction.invalid/services/rest',accountId:'DELIVERY_TEST'});
 globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith(base))return originalFetch(url,options);
  assert.equal(String(url),`https://delivery-instruction.invalid/services/rest/record/v1/salesOrder/${id}`);
  calls.push({...options,interactive:isOperatorNetSuiteRequest()});if(options.method==='PATCH')Object.assign(record,JSON.parse(options.body));
  return new Response(JSON.stringify(record),{status:200,headers:{'Content-Type':'application/json'}});
 };
});
after(async()=>{globalThis.fetch=originalFetch;Object.assign(config.netsuite,originalConfig);if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});
test('authenticated Sales API reads and writes exact native fields, verifies and audits the change',async()=>{
 const path=`/api/sales/delivery-instructions/orders/${id}/netsuite`;
 assert.equal((await http(path,null)).status,401);assert.equal((await http(path,'dispatch')).status,403);assert.equal((await http(path,'other')).status,403);assert.equal(calls.length,0);
 const loaded=await http(path,'sales');assert.equal(loaded.status,200);assert.equal(loaded.headers.get('cache-control'),'private, no-store');
 const input={expectedRevision:loaded.body.revision,expected:loaded.body.netSuite,values:{memo:'Call rear gate',shipDate:'2026-11-01',deliverByDate:'2026-11-02'}};
 assert.equal((await http(path,'other',input)).status,403);assert.equal((await http(path,'dispatch',input)).status,403);
 const saved=await http(path,'sales',input);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.revision,1);assert.deepEqual(saved.body.netSuite.values,input.values);
 assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
 assert(calls.every(call=>call.interactive),'All Sales NetSuite reads and writes must use interactive staff priority.');
 assert.deepEqual(JSON.parse(calls.find(c=>c.method==='PATCH').body),{custbody7:'Call rear gate',shipDate:'2026-11-01',custbody4:'2026-11-02'});
 assert.equal((await http(path,'sales',input)).status,409);assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
 assert.equal((await query("SELECT count(*)::int AS n FROM delivery_audit_log WHERE order_id=$1 AND action='delivery.instructions.netsuite.updated'",[id])).rows[0].n,1);
 const malformed=await http(path,'sales',{...input,expectedRevision:1,values:{...input.values,shipDate:'2026-09-31'}});assert.equal(malformed.status,400);
});
