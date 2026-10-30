import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../src/db.js';
import {persistedDispatchPlan} from '../src/dispatch-plan-fence.js';
import {dispatchRequiredPickupVisitLocations} from '../src/dispatch-pickup-visits.js';
import {planJobsForDriver} from '../src/driver-repository.js';
import {selectDriverRouteCursor} from '../src/driver-route-cursor.js';
import {getDeliveryOrder} from '../src/delivery-repository.js';
import {dispatchCargoFrontend} from './dispatch-history-cargo-oracle.mjs';

try {
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='15s'");
    const ref='GOB-122647-122650-122835-123218';
    const removed='stop-cbbe6b8f-7721-46bc-aac0-e04d671257fd';
    const row=(await query(`SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=367`)).rows[0];
    const plan=persistedDispatchPlan(row);
    const group=(await query('SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1',[ref])).rows[0].full_order;
    const requiredPickups=dispatchRequiredPickupVisitLocations(group,plan);
    if(!process.argv.includes('--observe')) assert.deepEqual(requiredPickups,['TECHO BLOC Vaughan']);
    const ui=dispatchCargoFrontend([group,...(group.childOrderDetails||[])]);
    const yardHover=ui.tooltipItemsForOrder(group,{pickupLocation:'3445'});
    const vendorHover=ui.tooltipItemsForOrder(group,{pickupLocation:'TECHO BLOC Vaughan'});
    if(!process.argv.includes('--observe')) assert.equal(yardHover.length,0);
    assert.ok(vendorHover.length>0);
    const truck=plan.trucks.find(t=>(t.loads||[]).some(l=>l.id==='T5-L1792753570068-aa81f1d2f81b98'));
    assert.ok(truck);
    assert.ok(truck.loads.every(l=>(l.stops||[]).every(s=>s.id!==removed)));
    const records=(await query('SELECT * FROM driver_job_records WHERE plan_id=367')).rows;
    const removedRecord=records.find(r=>String(r.id)==='7294');
    assert.equal(removedRecord.status,'superseded');
    assert.ok(removedRecord.started_at&&removedRecord.completed_at);
    const delivery=records.find(r=>String(r.id)==='7300');
    assert.ok(['in_progress','complete'].includes(delivery.status));
    const driver=delivery.driver_login;
    const jobs=planJobsForDriver(plan,driver);
    assert.ok(jobs.length);
    assert.ok(jobs.every(j=>j.stopId!==removed));
    const statuses=records.filter(r=>r.driver_login===driver);
    const cursor=selectDriverRouteCursor({jobs,statuses,activeRecords:statuses.filter(r=>r.status==='in_progress')});
    assert.equal(cursor.attention,null);
    const operator=[];
    const orders=(await query("SELECT netsuite_id,tranid FROM sales_orders WHERE tranid=ANY($1::text[])",
      [['SOB122647','SOB122650','SOB122835','SOB123218']])).rows;
    assert.equal(orders.length,4);
    for(const source of orders){
      const order=await getDeliveryOrder(source.netsuite_id,{includeNetSuiteClosed:true});
      assert.ok(order);
      const linked=order.lines.filter(l=>Number(l.linked_po_sales_qty)>0);
      assert.ok(linked.length);
      for(const line of linked){
        assert.equal(Number(line.operator_required_sales_qty),0);
        assert.equal(Number(line.quantity),0);
        assert.equal(line.no_yard_load_required,true);
      }
      operator.push({ref:source.tranid,linkedLines:linked.length,yardSalesQuantity:0});
    }
    const sor=(await query("SELECT line_snapshot,sor_review_reason FROM dispatch_custom_orders WHERE ref_number='SOR00248-Return'")).rows[0];
    assert.equal(Number(sor.line_snapshot[0].itemId),10750);
    assert.equal(sor.sor_review_reason,'');
    return {at:new Date().toISOString(),planRevision:plan.revision,requiredPickups,
      yardHoverItemCount:yardHover.length,vendorHoverItemCount:vendorHover.length,
      emptyPickupRemoved:true,driverHistoryRetained:true,deliveryRecordStatus:delivery.status,
      cursorJobId:cursor.job?.jobId||null,routeAttention:cursor.attention,operator,
      sor00248:{itemId:10750,reviewReason:''}};
  });
  console.log(JSON.stringify(result));
} finally {await closeDb();}
