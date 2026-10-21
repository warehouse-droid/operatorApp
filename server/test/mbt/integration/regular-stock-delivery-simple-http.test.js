import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {submitDeliveryStockRequest} from '../../../src/regular-stock-delivery.js';
import {config} from '../../../src/config.js';
const suffix=randomUUID(),actors={},tokens={},itemId=9800000000128;
const fixturePassword=randomUUID()+'-Delivery-A1!';
let server,base,request;
async function http(path,role,body,method='POST'){
 const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${tokens[role]}`}:{})},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 for(const [name,role,yards] of [['sales','sales',[28]],['other','sales',[15]],['scm','scm',[]],['driver','dispatcher',[]]]){
  const username=`delivery-${name}-${suffix}`;
  actors[name]=await createOperator({username,displayName:username,password:fixturePassword,role,roles:[role],yardLocationIds:yards});
  tokens[name]=(await http('/api/auth/login',null,{username,password:fixturePassword})).body.token;
 }
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt) VALUES($1,'Delivery HTTP material','EA',100) ON CONFLICT DO NOTHING",[itemId]);
 await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,15,'12441',100,100,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=100",[itemId]);
 const id=parseInt(suffix.replaceAll('-','').slice(0,10),16);
 request=await submitDeliveryStockRequest({sourceLocationId:15,destinationLocationId:28,salesOrderRef:`SO-HTTP-${suffix}`},
  {operatorId:actors.sales.id,authorizedDestinationLocationIds:[28]},
  {refreshAvailability:async()=>{},readOrder:async()=>({id,ref:`SO-HTTP-${suffix}`,locationId:28,lines:[{remoteLineId:1,itemId,quantity:5,backorderedQuantity:2,uom:'EA',locationId:28,open:true}]})});
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});
test('new Delivery HTTP rejects old item-entry payloads and inaccessible yards before any NetSuite call',async()=>{
 const body={deliveryMethod:'delivery',sourceLocationId:1,destinationLocationId:28};
 assert.equal((await http('/api/sales/stock-requests',null,body)).status,401);
 assert.equal((await http('/api/sales/stock-requests','driver',body)).status,403);
 assert.equal((await http('/api/sales/stock-requests','other',body)).status,400);
 assert.equal((await http('/api/sales/stock-requests','other',{...body,destinationLocationId:26})).status,403);
 assert.equal((await http('/api/sales/stock-requests','sales',body)).status,400);
 assert.equal((await http('/api/sales/stock-requests','sales',{...body,workflowVersion:1,arrivalDate:'2099-01-15',arrivalTime:'15:00',lines:[{itemId,pieces:1,sourceLocationId:1}]})).status,400);
});
test('manual Delivery HTTP preserves SCM permissions and immutable SO quantities',async()=>{
 const path=`/api/scm/stock-requests/${request.id}`,body={expectedRevision:request.revision,decision:'stock'};
 assert.equal((await http(path+'/line-decisions','sales',body)).status,403);
 assert.equal((await http(path+'/delivery-retry','sales',{})).status,403);
 assert.equal((await http(path+'/delivery-retry','scm',{})).status,409);
 assert.equal((await http(`/api/sales/stock-requests/${request.id}/sales-order/preview`,'sales',{salesOrderRef:request.regular.salesOrderRef})).status,409);
 assert.equal((await http(`/api/sales/stock-requests/${request.id}`,'sales',{expectedRevision:request.revision,deliveryMethod:'pickup'},'PATCH')).status,409);
 assert.equal((await http(path+`/lines/${request.lines[0].id}`,'scm',{expectedRevision:request.revision,salesQty:999},'PATCH')).status,409);
 assert.equal((await http(path+'/line-decisions','scm',{...body,decision:'po'})).status,400);
 assert.equal((await query('SELECT count(*)::int AS n FROM sales_stock_transfers WHERE request_id=$1',[request.id])).rows[0].n,0);
});
test('SCM retry HTTP returns the persisted attention state when external execution is disabled',async()=>{
 const old=config.smartScm.liveExecutionEnabled;config.smartScm.liveExecutionEnabled=false;
 try{
  const path=`/api/scm/stock-requests/${request.id}`;
  const approved=await http(path+'/line-decisions','scm',{expectedRevision:request.revision,decision:'stock'});
  assert.equal(approved.status,200);assert.equal(approved.body.regular.deliveryApproval,'approved');
  const retry=await http(path+'/delivery-retry','scm',{});
  assert.equal(retry.status,200);assert.equal(retry.body.id,request.id);assert.match(retry.body.regular.handoffError,/disabled/);
  assert.equal(retry.body.transfers.length,0);
 }finally{config.smartScm.liveExecutionEnabled=old;}
});

test('Delivery preview requires Sales authorization and validates the SO input',async()=>{
 const path='/api/sales/stock-requests/delivery/preview';
 assert.equal((await http(path,null,{})).status,401);
 assert.equal((await http(path,'driver',{})).status,403);
 assert.equal((await http(path,'sales',{})).status,400);
});
