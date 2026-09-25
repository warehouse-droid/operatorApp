import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {listDeliveryOrders} from '../../../src/delivery-repository.js';
after(closeDb);

async function fixture(type, {pending=false,inactive=false,packed=false}={}) {
  const sales=type==='sales_order';
  const table=sales?'sales_orders':'transfer_orders';
  const lineTable=sales?'sales_order_lines':'transfer_order_lines';
  const foreignKey=sales?'sales_order_id':'transfer_order_id';
  const statusColumn=sales?'operator_status':'outbound_operator_status';
  const parentId=sales?998118400:998118500;
  const parentRef=sales?'SOA998118400':'TOB998118500';
  for(const [index,suffix] of ['', '-S1','-S2'].entries()) {
    const id=index?-(parentId+index):parentId;
    const loaded=index>0 && !(pending && index===1);
    const status=loaded?'loaded':packed && !index?'packed':'open';
    await query(`INSERT INTO ${table}(netsuite_id,tranid,trandate,status,status_text,
      ${statusColumn},local_yard_order_status,fulfillment_status,netsuite_active,
      ${sales?'outbound_location_id,outbound_location,sales_order_type':'from_location_id,from_location,to_location_id,to_location'})
      VALUES($1,$2,current_date,'B','Pending Fulfillment',$3,$4,'not_fulfilled',$5,
      ${sales?"15,'12441','Delivery'":"15,'12441',28,'2967'"})`,
    [id,parentRef+suffix,status,loaded?'Loaded':'Open',!(inactive && index>0)]);
    const quantity=index?5:10;
    await query(`INSERT INTO ${lineTable}(${foreignKey},line_id,item_id,item_name,sku,item_type,
      quantity,piece_qty,to_pcs,unit,loaded_qty,packed_piece_qty,netsuite_active${sales?'':',line_stage'})
      VALUES($1,1,2340,'Split visibility item','SPLIT-VISIBILITY','InvtPart',$2,$2,1,'EA',$3,$4,true${sales?'':",'outbound'"})`,
    [id,quantity,loaded?quantity:0,status==='packed'?quantity:0]);
  }
  return {parentRef};
}

for(const type of ['sales_order','transfer_order']) {
  for(const scenario of [
    {name:'completed splits keep their parent out of Active', options:{}, status:'active', suffixes:[]},
    {name:'only the unfinished split appears in Active', options:{pending:true}, status:'active', suffixes:['-S1']},
    {name:'a cached packed parent stays hidden behind its completed splits', options:{packed:true}, status:'packed', suffixes:[]},
    {name:'inactive splits do not hide their unsplit parent', options:{inactive:true}, status:'active', suffixes:['']}
  ]) {
    test(`${type}: ${scenario.name}`,()=>withTransaction(async()=>{
      const {parentRef}=await fixture(type,scenario.options);
      const orders=await listDeliveryOrders({orderType:type,status:scenario.status,locationId:15});
      assert.deepEqual(orders.filter(order=>order.tranid.startsWith(parentRef)).map(order=>order.tranid).sort(),
        scenario.suffixes.map(suffix=>parentRef+suffix).sort());
    },{rollback:true}));
  }
}
