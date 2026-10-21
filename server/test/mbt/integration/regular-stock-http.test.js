import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import {app} from '../../../src/server.js';
import {submitRegularStockRequest} from '../../../src/regular-stock-request-service.js';
const run=randomUUID(),tokens={},actors={};
let server,base,requestId;
const itemId=9800000000040;
async function http(path,role,body,method=body?'POST':'GET'){
 const response=await fetch(`${base}${path}`,{method,headers:{...(role?{Authorization:`Bearer ${tokens[role]}`}:{ } ),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 return {status:response.status,body:await response.json()};
}
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'HTTP regular fixture','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
 await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT DO NOTHING",[itemId]);
 for(const [key,role,yards] of [['sales','sales',[28]],['other','sales',[1]],['peer','sales',[28]],['scm','scm',[]],['driver','dispatcher',[]]]){
   const username=`regular-${key}-${run}`;
   await createOperator({username,displayName:username,password:'Disposable-Regular-2026!',role,roles:[role],yardLocationIds:yards});
   actors[key]=(await query('SELECT id FROM operators WHERE username=$1',[username])).rows[0].id;
   const login=await http('/api/auth/login',null,{username,password:'Disposable-Regular-2026!'});assert.equal(login.status,200);tokens[key]=login.body.token;
 }
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});
test('HTTP requires staff role, a method, and the Sales yard for unchanged Pickup',async()=>{
 const input={destinationLocationId:28,deliveryMethod:'pickup',lines:[{itemId,sourceLocationId:1,pieces:201}]};
 assert.equal((await http('/api/sales/stock-requests',null,input)).status,401);
 assert.equal((await http('/api/sales/stock-requests','driver',input)).status,403);
 assert.equal((await http('/api/sales/stock-requests','other',input)).status,403);
 assert.equal((await http('/api/sales/stock-requests','sales',{...input,deliveryMethod:''})).status,400);
 const created=await http('/api/sales/stock-requests','sales',input);assert.equal(created.status,201);requestId=created.body.id;
 assert.equal(created.body.workflowVersion,2);assert.equal(created.body.regular.approval.automatic,false);
 assert.equal((await http(`/api/sales/stock-requests/${requestId}`,'other')).status,403);
 assert.equal((await http('/api/scm/stock-requests/alerts','sales')).status,403);
 assert((await http('/api/scm/stock-requests/alerts','scm')).body.manualReview>0);
});
test('manual rejection closes through HTTP and unread decisions are private and persistent',async()=>{
 const detail=(await http(`/api/scm/stock-requests/${requestId}`,'scm')).body;
 const body={expectedRevision:detail.revision,lineIds:detail.lines.map(line=>line.id),decision:'reject',reason:'No stock this week'};
 assert.equal((await http(`/api/scm/stock-requests/${requestId}/line-decisions`,'sales',body)).status,403);
 const decision=await http(`/api/scm/stock-requests/${requestId}/line-decisions`,'scm',body);assert.equal(decision.status,200);assert.equal(decision.body.status,'completed');
 const own=await http('/api/sales/stock-requests/alerts','sales');assert(own.body.requests.some(row=>row.id===requestId));
 for(const role of ['other','peer'])assert.equal((await http('/api/sales/stock-requests/alerts',role)).body.unread,0);
 const read={eventId:decision.body.manualDecisionEventId};
 assert.equal((await http(`/api/sales/stock-requests/${requestId}/decisions/read`,'peer',read)).status,403);
 assert.equal((await http(`/api/sales/stock-requests/${requestId}/decisions/read`,'sales',read)).status,200);
 assert.equal((await http('/api/sales/stock-requests/alerts','sales')).body.unread,0);
 assert.equal((await http('/api/scm/smart/regular-replenishments/1/release','sales',{expectedRevision:1})).status,403);
});
test('editing an undecided Delivery request and refreshing SCM evidence preserve mandatory fields and revision safety',async()=>{
 const input={destinationLocationId:28,deliveryMethod:'delivery',arrivalDate:'2099-01-15',arrivalTime:'2pm',lines:[{itemId,sourceLocationId:1,pieces:10}]};
 // Historical Delivery records keep their existing editing contract. New
 // HTTP submissions use the SO-based form covered by the delivery suites.
 const created={body:await submitRegularStockRequest(input,{operatorId:actors.sales,authorizedDestinationLocationIds:[28],allowOverAvailability:true},
  {refreshAvailability:async()=>{},loadPolicies:async()=>[]})};
 const edit=await http(`/api/sales/stock-requests/${created.body.id}`,'sales',{...input,customerName:'Customer revised',arrivalTime:'3pm',expectedRevision:created.body.revision},'PATCH');
 assert.equal(edit.status,200);assert.equal(edit.body.regular.customerName,'Customer revised');assert.equal(edit.body.regular.arrivalTime,'15:00');
 const evidence=await http(`/api/scm/stock-requests/${created.body.id}/evidence`,'scm',{});
 assert.equal(evidence.status,200);assert.equal(evidence.body.currentEvidence.length,1);assert.equal(evidence.body.regular.approval.automatic,false);
 const disabled=await http(`/api/sales/stock-requests/${created.body.id}/sales-order`,'sales',{salesOrderRef:'SO-test',expectedRevision:edit.body.revision});assert.equal(disabled.status,409);
});
