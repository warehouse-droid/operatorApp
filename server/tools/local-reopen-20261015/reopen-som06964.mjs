// User-authorized operational correction, attributed to their chosen Control account.
// Default invocation is read-only. The normal service supplies locks and audit history.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
import { config } from './src/config.js';
import { previewOperatorOrderReopen, reopenOperatorOrder } from './src/operator-order-reopen-repository.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from './src/dispatch-fleet-status.js';
import { locallyReopenedSalesOrderIds } from './src/local-sales-order-reopen.js';
import { isBilledSalesOrderIdentifier } from './src/sales-order-reconciliation-repository.js';
import { listDeliveryOrders } from './src/delivery-repository.js';
import { getSalesOrderPoAllocationOptions, listDispatchOrders } from './src/dispatch-repository.js';
import { overlayFulfilledSalesDeliveryPlanning } from './src/dispatch-fulfilled-so-repository.js';

config.netsuite.directAccessEnabled = false;
const apply = process.env.SOM06964_REOPEN_APPLY === '1';
const requestId = 'fd52b715-b15a-42af-9af2-a0325689f439';
const reason = 'User requested local reopen of SOM06964 in Dispatch and Operator despite erroneous NetSuite billing. Record under testAdmin as explicitly instructed; preserve NetSuite billing and existing PO links.';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const preservedState = async () => (await query(`SELECT
  to_jsonb(s)-ARRAY['operator_status','local_yard_order_status','fulfillment_status','preparing_operator_id','preparing_started_at','status_updated_at'] AS header,
  (SELECT jsonb_agg(to_jsonb(l)-ARRAY['packed_pallet_qty','packed_layer_qty','packed_section_qty','packed_piece_qty','packed_sales_qty','confirmed_at','confirmed','loaded_qty','loaded_uom','sync_exception','sync_exception_at'] ORDER BY l.id)
     FROM sales_order_lines l WHERE l.sales_order_id=s.netsuite_id) AS lines
  FROM sales_orders s WHERE s.netsuite_id=1049213`)).rows;

try {
  const result = await withTransaction(async () => {
    if (!apply) await query('SET TRANSACTION READ ONLY');
    else {
      await query("SET LOCAL lock_timeout='5s'");
      await query("SET LOCAL statement_timeout='60s'");
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    }
    const actors = (await query("SELECT id,username,role,roles,yard_location_ids,active FROM operators WHERE lower(username)=lower($1)", ['testAdmin'])).rows;
    assert.equal(actors.length, 1, 'The requested Control account must resolve uniquely');
    const row = actors[0];
    assert.equal(row.active, true);
    const actor = {id:row.id,username:row.username,role:row.role,roles:row.roles,yardLocationIds:row.yard_location_ids};
    const preview = await previewOperatorOrderReopen({orderRef:'SOM06964',actor});
    assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
    assert.deepEqual(preview.orders.map(order => order.orderRef), ['SOM06964']);
    const before = await preservedState();
    assert.equal(before[0].header.tranid, 'SOM06964');
    assert.equal(before[0].header.status, 'G');
    assert.match(before[0].header.status_text, /billed/iu);
    const allocations = (await getSalesOrderPoAllocationOptions('SOM06964')).allocations;
    assert.equal(allocations.length, 5);
    const prior = (await query('SELECT * FROM operator_order_reopens WHERE request_id=$1', [requestId])).rows[0];
    if (prior) {
      assert.equal(prior.actor_operator_id, actor.id);
      assert.equal(prior.reason, reason);
    }
    const correction = apply ? await reopenOperatorOrder({orderRef:'SOM06964', actor,
      expectedStateHash:prior?.expected_state_hash || preview.stateHash, reason, requestId}) : prior?.result;
    const reopened = (await locallyReopenedSalesOrderIds([1049213])).has('1049213');
    const orders = await overlayFulfilledSalesDeliveryPlanning(await listDispatchOrders({type:'SO',search:'SOM06964'}));
    const dispatch = orders.find(order => order.id==='SOM06964');
    const operator = (await listDeliveryOrders({locationId:26,status:'active',orderType:'sales_order',allowedOperatorYards:[26]}))
      .find(order => order.tranid==='SOM06964');
    const operatorAccessAllowed = !(await isBilledSalesOrderIdentifier('SOM06964'));
    if (apply || prior) {
      assert.equal(reopened, true);
      assert.equal(operatorAccessAllowed, true);
      assert.ok(operator);
      assert.equal(dispatch?.localOrderReopened, true);
      assert.equal(dispatch?.dispatchFulfilledSalesPlanningEligible, true);
      assert.equal(dispatch?.dispatchPlanningRestricted, false);
      assert.notEqual(dispatch?.dispatchCompletionStatus, 'completed');
      const audit = (await query('SELECT actor_operator_id,order_keys FROM operator_order_reopens WHERE id=$1', [correction.correctionId])).rows[0];
      assert.equal(audit.actor_operator_id, actor.id);
      assert.deepEqual(audit.order_keys, ['sales_order:1049213']);
    }
    assert.equal(hash(before), hash(await preservedState()), 'NetSuite facts or unaffected canonical state changed');
    assert.equal(hash(allocations), hash((await getSalesOrderPoAllocationOptions('SOM06964')).allocations), 'PO links changed');
    const status = (await query('SELECT status,status_text,operator_status,local_yard_order_status,fulfillment_status FROM sales_orders WHERE netsuite_id=1049213')).rows[0];
    return {at:new Date().toISOString(),orderRef:'SOM06964',applied:apply,readOnly:!apply,actorUsername:row.username,
      requestId,correction,previewAllowed:preview.allowed,localOrderReopened:reopened,
      dispatchPlanningEligible:dispatch?.dispatchFulfilledSalesPlanningEligible===true && dispatch?.dispatchPlanningRestricted===false,
      operatorActivePoolVisible:Boolean(operator),operatorAccessAllowed,
      status,existingPoAllocations:allocations.length,poLinksPreserved:true,netSuiteAndUnaffectedDataPreserved:true};
  });
  console.log(JSON.stringify(result,null,2));
} finally { await closeDb(); }
