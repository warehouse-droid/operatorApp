import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {specialUnitRepairPlan} from '../../../tools/special-unit-000024-plan.mjs';

function snapshot() {
  const header={request_ref:'SPREQ-000024',sales_order_netsuite_id:1033108,purchase_order_netsuite_id:null,close_status:'active',sales_order_operation_status:'linked',purchase_order_operation_status:'idle',quantity_review:{}};
  const lines=[],orders=[],canonical=[],units=[];
  const remote={id:1033108,ref:'SOB121882',customerId:2008,locationId:1,lines:[]};
  const data=[[36,59,60,5065607,144,'Arcana MODENA 24 x 24 \n72.00SQFT/PLT','Arcana MODENA 24 x 24 72.00SQFT/PLT'],[37,61,62,5065608,162,'Arcana MODENA 18 x 24\n54SQFT/PLT','Arcana MODENA 18 x 24'],[38,63,64,5065609,108,'Arcana MODENA 12 x 24\n36SQFT/PLT','Arcana MODENA 12 x 24']];
  for(const [id,so,po,remoteId,quantity,description,poDescription] of data) {
    lines.push({id,requested_quantity:quantity,requested_uom:'SQFT',original_rate_uom:'SQFT',original_unit_rate:17.95,sales_package_quantity:quantity,pieces_per_unit:1,sales_uom:'PC',purchase_uom:'PC',sales_quantity:quantity,purchase_quantity:quantity});
    for(const [orderId,kind,desc,rate,lineId] of [[so,'sales_order',description,17.95,remoteId],[po,'purchase_order',poDescription,null,null]])orders.push({id:orderId,case_line_id:id,order_kind:kind,item_id:2055,description:desc,quantity,uom:'PC',unit_rate:rate,unit_purchase_cost:null,remote_line_id:lineId});
    canonical.push({line_id:remoteId,item_id:2055,item_description:description,quantity,unit:'SQFT',netsuite_active:true});
  }
  for(const [id,remoteId,itemId,quantity,rate,uom] of [[65,5065610,1784,8,40,'EACH'],[66,5065720,1987,1,235,null]]) {
    orders.push({id,case_line_id:null,order_kind:'sales_order',item_id:itemId,quantity,uom,unit_rate:rate,unit_purchase_cost:null,remote_line_id:remoteId});
    canonical.push({line_id:remoteId,item_id:itemId,quantity,unit:uom,netsuite_active:true});
  }
  for(const row of canonical) {
    units.push({line_id:row.line_id,item:row.item_id,quantity:row.quantity,uom:row.unit});
    remote.lines.push({remoteLineId:row.line_id,itemId:row.item_id,quantity:row.quantity,rate:row.item_id===2055?17.95:row.item_id===1784?40:235,open:true,locationId:1});
  }
  return {header,lines,orders,canonical,remote,units};
}
test('SQFT correction changes exactly six material order units and three case units',()=>{
  const data=snapshot(),before=JSON.stringify(data);
  assert.deepEqual(specialUnitRepairPlan(data),{orderIds:[59,60,61,62,63,64],caseLineIds:[36,37,38],from:'PC',to:'SQFT'});
  assert.equal(JSON.stringify(data),before);
});
test('unit repair rejects unrelated identities, billing, descriptions, quantities and concurrent operations',()=>{
  const changes=[data=>{data.header.purchase_order_netsuite_id=12;},data=>{data.header.purchase_order_operation_status='creating';},data=>{data.remote.customerId=1;},data=>{data.orders[0].description='Changed';},data=>{data.units[0].uom='PC';},data=>{data.canonical[0].unit='PC';},data=>{data.orders[1].unit_purchase_cost=1;},data=>{data.remote.lines[4].rate=236;},data=>{data.orders[7].unit_rate=236;},data=>{data.lines[0].original_rate_uom='PC';}];
  for(const change of changes){const data=snapshot();change(data);assert.throws(()=>specialUnitRepairPlan(data));}
});
test('property: all unexpected material rate or quantity changes abort the repair',()=>{
  fc.assert(fc.property(fc.integer({min:0,max:2}),fc.double({min:.01,max:10000,noNaN:true}), (index,value)=>{
    fc.pre(value!==17.95);const data=snapshot();data.remote.lines[index].rate=value;assert.throws(()=>specialUnitRepairPlan(data));
    const next=snapshot();next.remote.lines[index].quantity+=value;assert.throws(()=>specialUnitRepairPlan(next));
  }),{seed:2026100124,numRuns:200});
});
