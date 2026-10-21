import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';

export async function fixture({sku=88999701}={}) {
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  const users={},ids=[],run=crypto.randomUUID(),nativeFetch=globalThis.fetch;
  const originalFlag=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor) VALUES($1,'TEST-ALREADY-ORDERED','Already ordered test material','EA','TEST Vendor') ON CONFLICT DO NOTHING",[sku]);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  for(const role of ['sales','scm','foreign']) {
    const username='already-'+role+'-'+run,password=crypto.randomUUID(),actual=role==='foreign'?'sales':role;
    users[role]=await createOperator({username,password,displayName:'TEST '+role,role:actual,roles:[actual],yardLocationIds:actual==='sales'?[role==='foreign'?28:1]:[]});
    const response=await nativeFetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(response.status,200);users[role].token=(await response.json()).token;
  }
  const path=(d,role,action)=>`/api/${role}/stock-requests/${d.id}/backorder/${action}`;
  async function http(role,url,body) {
    const response=await nativeFetch(base+url,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+users[role].token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  }
  async function create(count=2) {
    const result=await http('sales','/api/sales/stock-requests',{deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',
      lines:Array.from({length:count},(_,i)=>({itemId:sku,salesQty:i+2,quantityMode:'direct',requiredDate:'2099-02-01'}))});
    assert.equal(result.status,201,JSON.stringify(result.body));ids.push(result.body.id);return result.body;
  }
  async function action(d,role,name,input={}) {
    const result=await http(role,path(d,role,name),{expectedRevision:d.revision,...input});
    assert.equal(result.status,200,JSON.stringify(result.body));return result.body;
  }
  const ordered=(d,index=0,input={})=>action(d,'scm',`lines/${d.lines[index].id}/response`,{supplyStatus:'already_ordered',poNumber:'PO-UNSYNCED-'+d.id,...input});
  const review=(d,index=0)=>action(d,'scm',`lines/${d.lines[index].id}/response`,{supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST yard'});
  const detail=async(d,role='sales')=>(await http(role,`/api/${role}/stock-requests/${d.id}`)).body;
  async function close() {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);
    for(const user of Object.values(users)) {
      await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[user.id]);
      await query('DELETE FROM operators WHERE id=$1',[user.id]);
    }
    await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[originalFlag]);
    await closeDb();
  }
  return {base,users,path,http,create,action,ordered,review,detail,close,query};
}
