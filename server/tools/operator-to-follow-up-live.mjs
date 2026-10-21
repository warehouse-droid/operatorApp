// Operational verification: read-only database connections and NetSuite SELECTs.
import assert from 'node:assert/strict';
const {config}=await import('./src/config.js');
const {pool,query,withTransaction,closeDb}=await import('./src/db.js');
pool.options.options='-c default_transaction_read_only=on -c statement_timeout=15000 -c jit=off';pool.options.max=1;
try {
  const {activeNetSuiteLocationDirectory}=await import('./src/netsuite.js');
  const {setOutboundLocationDirectory,outboundYardLocationId}=await import('./src/outbound-location-domain.js');
  setOutboundLocationDirectory(await activeNetSuiteLocationDirectory());
  assert.equal(outboundYardLocationId(37),28);
  config.netsuite.directAccessEnabled=false;
  const {getDeliveryOrder,listDeliveryOrders,listDeliveryLoadOrders,getDeliveryBootstrap}=await import('./src/delivery-repository.js');
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const completed=(await query(`SELECT netsuite_id,tranid,status,status_text,from_location_id,to_location_id,
      outbound_operator_status,local_yard_order_status,receiving_status FROM transfer_orders WHERE netsuite_id=1046504`)).rows[0];
    assert.equal(completed.status,'G');assert.equal(completed.outbound_operator_status,'open');
    assert.equal(completed.receiving_status,'not_received');
    const match=order=>String(order.netsuite_id)==='1046504'||String(order.tranid).includes('TOB01210')||(order.child_order_refs||[]).includes('TOB01210');
    const lists=[];
    for(const status of ['active','packed']) {
      const rows=await listDeliveryOrders({locationId:28,status,orderType:'transfer_order',allowedOperatorYards:[28]});
      assert.deepEqual(rows.filter(match),[]);lists.push({list:status,count:rows.length,completedTransferAbsent:true});
    }
    const planned=await listDeliveryLoadOrders({locationId:28,planDate:'2026-10-07',truckPlate:'BL42349',allowedOperatorYards:[28]});
    assert.deepEqual(planned.filter(match),[]);lists.push({list:'planned-loading',date:'2026-10-07',truck:'BL42349',completedTransferAbsent:true});
    const bootstrap=await getDeliveryBootstrap({locationId:28,allowedOperatorYards:[28]});
    assert.deepEqual(bootstrap.orders.transferOrder.filter(match),[]);lists.push({list:'operator-bootstrap',completedTransferAbsent:true});
    assert.ok(await getDeliveryOrder(1046504));
    assert.ok(!bootstrap.orders.salesOrder.some(o=>['1055868','1055869','GOA-10172-10173'].includes(String(o.netsuite_id))));
    const transfer=(await query(`SELECT netsuite_id,tranid,status,to_location_id,to_location,outbound_operator_status
      FROM transfer_orders WHERE netsuite_id=1057103`)).rows[0];
    assert.equal(Number(transfer.to_location_id),15);assert.equal(transfer.outbound_operator_status,'packed');
    const state=(await query(`SELECT id,application_status,reconciliation_status FROM scm_reconciliation_order_state WHERE order_kind='TO' AND source_order_netsuite_id=1057103`)).rows[0];
    assert.equal(state.application_status,'Planned');assert.equal(state.reconciliation_status,'current');
    const review=(await query('SELECT id,status,resolved_at,resolution_action FROM scm_reconciliation_review_cases WHERE id=412')).rows[0];
    assert.equal(review.status,'resolved');assert.equal(review.resolution_action,'accept');
    assert.equal(new Date(review.resolved_at).toISOString(),'2026-10-13T20:43:08.344Z');
    assert.equal((await query("SELECT count(*)::int AS n FROM scm_reconciliation_review_cases WHERE order_state_id=$1 AND status='open'",[state.id])).rows[0].n,0);
    const schedule=(await query("SELECT status,reconciliation_blocked FROM scm_transport_schedule WHERE order_kind='TO' AND order_ref='TOB01230'")).rows[0];
    assert.equal(schedule.status,'Planned');assert.equal(schedule.reconciliation_blocked,false);
    return {completedTransfer:{header:completed,operatorLists:lists,historyAccessible:true},
      destinationEdit:{header:transfer,reconciliation:state,acceptedReview:review,schedule,openReviews:0},
      priorDirectShipOrderStillFiltered:true,databaseReadOnly:true};
  },{rollback:true});
  assert.equal(config.mbr.enabled,true);
  console.log(JSON.stringify({verifiedAt:new Date().toISOString(),mbrEnabled:true,...result}));
}finally{await closeDb();}
