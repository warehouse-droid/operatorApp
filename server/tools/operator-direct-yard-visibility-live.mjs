// Execute through stdin in production with a read-only database connection.
import assert from 'node:assert/strict';
const {config}=await import('./src/config.js');
const {pool,query,withTransaction,closeDb}=await import('./src/db.js');
pool.options.options='-c default_transaction_read_only=on -c statement_timeout=15000 -c jit=off';
pool.options.max=1;
// Restrict this diagnostic process to the existing local location directory.
config.netsuite.directAccessEnabled=false;
try {
  const {getDeliveryOrder,listDeliveryOrders,listDeliveryLoadOrders,getDeliveryBootstrap}=await import('./src/delivery-repository.js');
  const refs=new Set(['1055868','1055869','GOA-10172-10173']);
  const matches=order=>refs.has(String(order.netsuite_id))
    || /SOA10172|SOA10173|GOA-10172-10173/u.test(String(order.tranid));
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const checks=[];
    for(const status of ['active','packed']) {
      const rows=await listDeliveryOrders({locationId:28,status,orderType:'sales_order',allowedOperatorYards:[28]});
      assert.deepEqual(rows.filter(matches),[],status+' operator list');
      checks.push({list:status,count:rows.length,reportedOrdersAbsent:true});
    }
    const group=await getDeliveryOrder('GOA-10172-10173');
    assert.ok(group);
    const dateValue=group.dispatch_plan_date||'2026-10-13';
    const planDate=dateValue instanceof Date?dateValue.toISOString().slice(0,10):String(dateValue).slice(0,10);
    assert.match(planDate,/^\d{4}-\d{2}-\d{2}$/u);
    const truckPlate=group.dispatch_truck_plate||'CC46868';
    const planned=await listDeliveryLoadOrders({locationId:28,status:'active',planDate,truckPlate,allowedOperatorYards:[28]});
    assert.deepEqual(planned.filter(matches),[],'planned operator loading list');
    checks.push({list:'planned-loading',planDate,truckPlate,count:planned.length,reportedOrdersAbsent:true});
    const bootstrap=await getDeliveryBootstrap({locationId:28,allowedOperatorYards:[28]});
    assert.deepEqual(bootstrap.orders.salesOrder.filter(matches),[],'operator bootstrap list');
    checks.push({list:'operator-bootstrap',count:bootstrap.orders.salesOrder.length,reportedOrdersAbsent:true});
    const order=await getDeliveryOrder(1055868);
    const lines=order.lines.filter(line=>[1189,3632].includes(Number(line.item_id))).map(line=>({
      itemId:Number(line.item_id),item:line.item_name,directShip:Number(line.linked_direct_to_sales_qty),
      yardRequired:Number(line.operator_required_sales_qty),noYardLoadRequired:Boolean(line.no_yard_load_required)}));
    assert.equal(lines.length,2);
    assert.ok(lines.every(line=>line.noYardLoadRequired && line.yardRequired===0));
    const statuses=(await query('SELECT netsuite_id,operator_status,local_yard_order_status FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id',[[1055868,1055869]])).rows;
    assert.ok(statuses.every(row=>row.operator_status==='partial_loaded'));
    return {checks,detailReferencesPreserved:true,lines,orderStatuses:statuses,databaseReadOnly:true};
  },{rollback:true});
  assert.equal(config.mbr.enabled,true);
  console.log(JSON.stringify({verifiedAt:new Date().toISOString(),mbrEnabled:true,...result}));
}finally{await closeDb();}
