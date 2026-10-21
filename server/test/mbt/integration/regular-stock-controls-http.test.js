import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import {app} from '../../../src/server.js';
import {submitRegularStockRequest} from '../../../src/regular-stock-request-service.js';
const run=randomUUID(),tokens={},actors={},itemId=9800000000078;
let server,base;
async function http(path,role,body){
 const response=await fetch(`${base}${path}`,{method:'POST',headers:{...(role?{Authorization:`Bearer ${tokens[role]}`}:{ } ),'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'HTTP approval controls','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
 await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT DO NOTHING",[itemId]);
 for(const [key,role,yards] of [['sales','sales',[28]],['other','sales',[1]],['driver','dispatcher',[]]]){
  const username=`regular-controls-${key}-${run}`;
  await createOperator({username,displayName:username,password:'Disposable-Regular-2026!',role,roles:[role],yardLocationIds:yards});
  actors[key]=(await query('SELECT id FROM operators WHERE username=$1',[username])).rows[0].id;
  tokens[key]=(await http('/api/auth/login',null,{username,password:'Disposable-Regular-2026!'})).body.token;
 }
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});
test('re-raise HTTP enforces Sales access and yard scope, refreshes expiry, and rejects duplicated submissions',async()=>{
 const request=await submitRegularStockRequest({destinationLocationId:28,deliveryMethod:'delivery',arrivalDate:'2099-01-15',arrivalTime:'15:00',lines:[{itemId,sourceLocationId:1,pieces:200}]},
  {operatorId:actors.sales,authorizedDestinationLocationIds:[28],allowOverAvailability:true},
  {refreshAvailability:async()=>{},loadPolicies:async()=>[{itemId,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}]});
 const path=`/api/sales/stock-requests/${request.id}/re-raise`,input={expectedRevision:request.revision};
 assert.equal((await http(path,null,input)).status,401);assert.equal((await http(path,'driver',input)).status,403);assert.equal((await http(path,'other',input)).status,403);
 assert.equal((await http(path,'sales',input)).status,409);
 await query("UPDATE sales_stock_requests SET regular_details=regular_details||'{\"approvalExpiresAt\":\"2000-01-01T00:00:00Z\"}'::jsonb WHERE id=$1",[request.id]);
 const expired=await http(`/api/sales/stock-requests/${request.id}/sales-order/preview`,'sales',{salesOrderRef:'SOB-EXPIRED'});
 assert.equal(expired.status,409);assert.match(JSON.stringify(expired.body),/Approval expired after 15 minutes/);
 const results=await Promise.all([http(path,'sales',input),http(path,'sales',input)]);
 assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
 const raised=results.find(row=>row.status===200).body;
 assert.equal(raised.revision,request.revision+1);assert.equal(raised.lines[0].status,'submitted');
 assert.equal(raised.regular.approvalExpiresAt,null);assert(raised.regular.approval.lines[0].reasons.includes('policy_unavailable'));
 assert.equal((await query("SELECT count(*)::int AS n FROM sales_stock_request_events WHERE request_id=$1 AND event_type='regular_approval_reraised'",[request.id])).rows[0].n,1);
});
