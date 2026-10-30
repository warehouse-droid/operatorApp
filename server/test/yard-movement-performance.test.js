import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fc from 'fast-check';
import {closeDb,query,beginRollbackContext} from '../src/db.js';
import {getYardMovementDetail,listYardMovements} from '../src/yard-movement-repository.js';
import {yardPerformanceFixture} from './support/yard-movement-performance-fixture.mjs';
let fixture,rollback;
before(async()=>{rollback=await beginRollbackContext();await rollback.run(async()=>{fixture=await yardPerformanceFixture();});});
after(async()=>{await rollback?.rollback();await closeDb();});
const nodes=plan=>[plan,...(plan.Plans||[]).flatMap(nodes)];
async function capturePlans(action) {
  const original=pg.Client.prototype.query, plans=[];
  pg.Client.prototype.query=function(sql,...args) {
    if(!String(sql).startsWith('WITH movement_records')) return original.call(this,sql,...args);
    return original.call(this,'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,...args).then(result=>{
      plans.push(result.rows[0]['QUERY PLAN'][0]);return original.call(this,sql,...args);
    });
  };
  try{return {result:await action(),plans};}finally{pg.Client.prototype.query=original;}
}
test('P2: a selected detail matches only its own driver reference before joining history',async()=>rollback.run(async()=>{
  const {result,plans}=await capturePlans(()=>getYardMovementDetail({...fixture.range,direction:'outbound',orderType:'sales_order',orderId:fixture.ids[0]}));
  assert.equal(result.order.tranid,fixture.refs[0]);assert.equal(result.driverRecords.length,1);
  assert.equal(result.photos[0].photo_data_url,fixture.photo);assert.equal(result.driverPhotos[0].photo_data_url,fixture.photo);
  const intermediates=plans.flatMap(plan=>nodes(plan.Plan)).filter(node=>node['Subplan Name']==='CTE driver_record_refs');
  assert.ok(intermediates.length>=1);
  assert.ok(intermediates.every(node=>node['Actual Rows']<=1),JSON.stringify(intermediates.map(node=>({rows:node['Actual Rows'],loops:node['Actual Loops']}))));
}));
test('P2: global searches use the existing normalized PO alias indexes',async()=>rollback.run(async()=>{
  const {result,plans}=await capturePlans(()=>listYardMovements({...fixture.range,search:fixture.refs[0]}));
  assert.deepEqual(result.map(row=>row.tranid),[fixture.refs[0]]);
  const indexes=plans.flatMap(plan=>nodes(plan.Plan)).map(node=>node['Index Name']).filter(Boolean);
  assert.ok(indexes.includes('idx_purchase_orders_dispatch_ref_lower'),JSON.stringify(indexes));
}));
test('P1/A1: case and whitespace variants preserve driver precedence and yard scope',async()=>rollback.run(async()=>{
  const po=fixture.ids[0]+9000;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,destination_location_id,destination_location) VALUES($1,$2,28,'2967')",[po,fixture.refs[0]]);
  await query("INSERT INTO receiving_receipt_records(order_id,receipt_status,created_at) VALUES($1,'received',$2)",[po,fixture.day+'T11:00:00Z']);
  const selected={...fixture.range,direction:'outbound',orderType:'sales_order',orderId:fixture.ids[0]};
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(),{minLength:fixture.refs[0].length,maxLength:fixture.refs[0].length}),fc.integer({min:0,max:3}),async(cases,padding)=>{
    const reference=' '.repeat(padding)+[...fixture.refs[0]].map((c,i)=>cases[i]?c.toLowerCase():c.toUpperCase()).join('')+' '.repeat(padding);
    await query('UPDATE driver_job_records SET order_refs=$2 WHERE job_id=$1',[fixture.prefix,JSON.stringify([reference])]);
    const detail=await getYardMovementDetail({...selected,allowedYardLocationIds:[1]});
    assert.equal(detail.driverRecords.length,1);assert.equal(detail.driverPhotos.length,1);
    assert.equal(detail.driverRecords[0].job_details.notes,'Preserved detail');
    const other=await getYardMovementDetail({...fixture.range,direction:'inbound',orderType:'purchase_order',orderId:po,allowedYardLocationIds:[28]});
    assert.equal(other.driverRecords.length,0,'SO priority must win a reference collision across families');
  }),{seed:20261022,numRuns:15});
  for(const scope of [{allowedYardLocationIds:[]},{allowedYardLocationIds:[28]},{allowedSalesStoreLocationIds:[]},{allowedSalesStoreLocationIds:[28]}]) {
    assert.equal(await getYardMovementDetail({...selected,...scope}),null);
    assert.deepEqual(await listYardMovements({...fixture.range,search:fixture.refs[1],...scope}),[]);
  }
}));
test('A1: malformed, out-of-range and missing order identities return no detail',async()=>rollback.run(async()=>{
  for(const orderId of ['',null,'1 OR 1=1','1.0','01','-0','9223372036854775808','-9223372036854775809',String(fixture.ids[0]+99999)]) {
    assert.equal(await getYardMovementDetail({...fixture.range,direction:'outbound',orderType:'sales_order',orderId}),null);
  }
}));
