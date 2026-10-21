import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {createSalesStockRequest,getSalesStockRequest} from '../../../src/stock-request-repository.js';
import {createOperator} from '../../../src/auth-repository.js';
import crypto from 'node:crypto';

let f;const extra=[];
before(async()=>{
  f=await fixture({sku:88999519});
  await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,synced_at) VALUES(88999519,28,'2967',100,100,now())");
});
after(async()=>{if(f){try{await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[extra]);}finally{await f.close();}}});
const list=async(status,more='')=>{
  const result=await f.http('sales','/api/sales/stock-requests?status='+encodeURIComponent(status)+more);
  assert.equal(result.status,200,JSON.stringify(result.body));return result.body.requests;
};
test('The API filters actual Backorder stages and stock checks without the old Pending bucket hiding completed records',async()=>{
  let active=await f.create(1),confirmed=await f.review(await f.create(1));
  confirmed=await f.action(confirmed,'sales',`lines/${confirmed.lines[0].id}/decision`,{decision:'accepted'});
  const pending=await f.action(await f.create(1),'scm','information/request',{question:'TEST confirm requirements'});
  const completed=await f.ordered(await f.create(1));
  const closed=await f.action(await f.create(1),'sales','close',{reason:'TEST closed'});
  for(const [status,row] of [['new_enquiry',active],['confirmed',confirmed],['pending_update',pending],['completed',completed],['closed',closed]]){
    assert.deepEqual((await list(status)).map(d=>d.id),[row.id],status);
    assert.equal((await list(status))[0].displayStatus,status);
  }
  assert.deepEqual((await list('supply:in_stock')).map(d=>d.id),[confirmed.id]);
  assert.deepEqual((await list('supply:already_ordered')).map(d=>d.id),[completed.id]);
  active=await f.review(active);
  assert.deepEqual((await list('await_customer_confirmation')).map(d=>d.id),[active.id]);
  const own=(await f.http('sales','/api/sales/stock-requests/alerts')).body.stockChecks;
  assert.ok(own.some(row=>row.id===active.id&&row.message.includes('In stock')));
  assert.ok(own.some(row=>row.id===completed.id&&row.message.includes('Already Ordered')));
  const username='notice-colleague-'+crypto.randomUUID(),password=crypto.randomUUID();
  f.users.colleague=await createOperator({username,password,displayName:'TEST colleague',role:'sales',roles:['sales'],yardLocationIds:[1]});
  const login=await fetch(f.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
  assert.equal(login.status,200);f.users.colleague.token=(await login.json()).token;
  assert.ok((await f.http('colleague','/api/sales/stock-requests?status=confirmed')).body.requests.some(row=>row.id===confirmed.id));
  assert.deepEqual((await f.http('colleague','/api/sales/stock-requests/alerts')).body.stockChecks,[]);
  assert.deepEqual((await list('confirmed','&vendor=NOT-A-VENDOR')),[]);
  assert.deepEqual((await list('confirmed','&type=backorder&stage=closed')),[]);
  const foreign=await f.http('foreign','/api/sales/stock-requests?status=confirmed');assert.equal(foreign.status,200);assert.deepEqual(foreign.body.requests,[]);
  for(const value of ['unknown','pending,completed',"' OR true --"]){const r=await f.http('sales','/api/sales/stock-requests?status='+encodeURIComponent(value));assert.equal(r.status,400);}
});
test('Stocking reply and resolution statuses match their displayed badges and are filtered before pagination',async()=>{
  const create=async(regular,status='submitted')=>{
    const d=await createSalesStockRequest({destinationLocationId:1,lines:[{itemId:88999519,sourceLocationId:28,salesQty:1}]},{operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1],allowOverAvailability:true});extra.push(d.id);
    await f.query('UPDATE sales_stock_requests SET workflow_version=2,regular_details=$2::jsonb,status=$3 WHERE id=$1',[d.id,JSON.stringify({deliveryMethod:'stocking',...regular}),status]);
    return d;
  };
  const scm=await create({replyStatus:'pending_scm'}),update=await create({replyStatus:'pending_update'}),resolved=await create({resolution:{reason:'TEST received'}});
  for(const [status,d] of [['pending_scm',scm],['pending_update',update],['resolved',resolved]]){
    const detail=await getSalesStockRequest(d.id,{authorizedDestinationLocationIds:[1]});assert.equal(detail.displayStatus,status);
    const result=await list(status);assert.ok(result.some(row=>row.id===d.id));
  }
  // Put more than one summary batch ahead of the matching old request.
  const fillers=(await f.query(`INSERT INTO sales_stock_requests(destination_location_id,destination_name,requested_by,workflow_version,regular_details)
    SELECT 1,'3445',$1,2,'{"deliveryMethod":"stocking"}' FROM generate_series(1,260) RETURNING id`,[f.users.sales.id])).rows.map(r=>Number(r.id));extra.push(...fillers);
  const results=await list('pending_scm','&limit=1');assert.deepEqual(results.map(d=>d.id),[scm.id]);
  assert.deepEqual(await list('pending_scm','&limit=1&offset=1'),[]);
  assert.deepEqual(await list('pending_scm','&search=NO-SUCH-REQUEST'),[]);
});
