import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {createSalesStockRequest} from '../../../src/stock-request-repository.js';

let f; const ids=[];
before(async()=>{f=await fixture({sku:88999529});
  await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,synced_at) VALUES(88999529,28,'2967',100,100,now())");
});
after(async()=>{if(f){try{await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);}finally{await f.close();}}});
const list=async(params={},role='sales')=>{
  const r=await f.http(role,'/api/sales/stock-requests?'+new URLSearchParams(params));
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body.requests;
};

test('Multi-select filters union values, intersect categories, retain pagination and yard scope, and keep Special out of Regular',async()=>{
  const active=await f.create(2),completed=await f.ordered(await f.create(1)),closed=await f.action(await f.create(1),'sales','close',{reason:'TEST closed'});
  await f.query("UPDATE sales_special_stock_lines SET brand='TEST, Vendor A',response_vendor_name='TEST, Vendor A' WHERE request_id=$1",[active.id]);
  await f.query("UPDATE sales_special_stock_lines SET brand='TEST Vendor B',response_vendor_name='TEST Vendor B' WHERE request_id=$1",[completed.id]);
  const stocking=await createSalesStockRequest({destinationLocationId:1,lines:[{itemId:88999529,sourceLocationId:28,salesQty:1}]},{operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1],allowOverAvailability:true});ids.push(stocking.id);
  await f.query("UPDATE sales_stock_requests SET workflow_version=2,regular_details='{\"deliveryMethod\":\"stocking\"}' WHERE id=$1",[stocking.id]);
  // Special and foreign-yard rows must not join the selected regular workflow.
  const special=(await f.query("INSERT INTO sales_stock_requests(request_type,destination_location_id,destination_name,requested_by) VALUES('special',1,'3445',$1) RETURNING id",[f.users.sales.id])).rows[0];ids.push(Number(special.id));
  const all=await list();assert.ok(!all.some(row=>row.id===Number(special.id)));
  const params={stage:'new_enquiry,completed',type:'stocking,backorder',vendors:JSON.stringify(['TEST, Vendor A','TEST Vendor B'])};
  assert.deepEqual((await list(params)).map(row=>row.id).sort((a,b)=>a-b),[active.id,completed.id].sort((a,b)=>a-b));
  assert.deepEqual((await list({...params,vendors:JSON.stringify(['TEST, Vendor A'])})).map(row=>row.id),[active.id]);
  assert.deepEqual((await list({...params,type:'stocking'})),[]);
  assert.deepEqual((await list({type:'stocking,backorder'})).map(row=>row.id).sort((a,b)=>a-b),[active.id,completed.id,closed.id,stocking.id].sort((a,b)=>a-b));
  assert.deepEqual((await list({stage:'closed'})).map(row=>row.id),[closed.id]);
  assert.deepEqual((await list({type:'backorder',stage:'completed',vendor:'TEST Vendor B'})).map(row=>row.id),[completed.id]);
  assert.deepEqual(await list(params,'foreign'),[]);
  assert.deepEqual(await list({...params,search:'NO-MATCH'}),[]);
  assert.deepEqual(await list({...params,requestDate:'2000-01-01'}),[]);
  assert.deepEqual(await list({...params,sourceLocationIds:'15,26'}),[]);
  // Matching stages and vendors must be applied before the first page, even behind >100 newer requests.
  const filler=(await f.query(`INSERT INTO sales_stock_requests(destination_location_id,destination_name,requested_by,workflow_version,regular_details)
    SELECT 1,'3445',$1,2,'{"deliveryMethod":"stocking"}' FROM generate_series(1,210) RETURNING id`,[f.users.sales.id])).rows;ids.push(...filler.map(row=>Number(row.id)));
  const expected=(await list(params)).map(row=>row.id);
  assert.equal(expected.length,2);
  assert.deepEqual((await list({...params,limit:'1'})).map(row=>row.id),expected.slice(0,1));
  assert.deepEqual((await list({...params,limit:'1',offset:'1'})).map(row=>row.id),expected.slice(1));
  assert.deepEqual(await list({...params,limit:'1',offset:'2'}),[]);
  const repeated=await f.http('sales','/api/sales/stock-requests?stage=new_enquiry&stage=completed&type=stocking&type=backorder');
  assert.equal(repeated.status,200);assert.deepEqual(repeated.body.requests.map(row=>row.id),expected);
  for(const query of ['stage=unknown','stage[bad]=completed','type=unknown','type=backorder,unknown','vendors={}','vendors=[null]']) {
    const r=await f.http('sales','/api/sales/stock-requests?'+query);assert.equal(r.status,400,query);
  }
});
