import { closeDb, query, withTransaction } from '../src/db.js';
import { listScmSchedule } from '../src/dispatch-repository.js';
import { listScmPurchaseOrderCatalog, getScmPurchaseOrderCatalogOrder } from '../src/scm-purchase-order-catalog-repository.js';

const ref = process.argv[2] || 'SN1401822';
const card = (order) => order && ({
  id: order.id, originalPoRef: order.originalPoRef, dispatchRef: order.dispatchRef,
  sourcePoRef: order.sourcePoRef, correspondingPoRefs: order.correspondingPoRefs,
  isScmSplit: order.isScmSplit, dispatchPlanned: order.dispatchPlanned,
  dispatchCompleted: order.dispatchCompleted, dispatchPlanId: order.dispatchPlanId,
  dispatchPlanDate: order.dispatchPlanDate, dispatchPlannedOrderRef: order.dispatchPlannedOrderRef,
  status: order.scm?.status, scheduleId: order.scm?.scheduleId, updatedAt: order.scm?.updatedAt
});
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await query("SET LOCAL statement_timeout = '45s'");
    const schedule = await listScmSchedule({search: ref, audience: 'scm'});
    const catalog = await listScmPurchaseOrderCatalog({search: ref});
    const details = [];
    for (const order of catalog.orders) details.push(card(await getScmPurchaseOrderCatalogOrder(order.id)));
    const mirrors = await query(`SELECT netsuite_id, tranid, dispatch_ref, initial_scm_status,
      status_text, netsuite_active, synced_at FROM purchase_orders
      WHERE tranid ILIKE $1 OR dispatch_ref ILIKE $1`, ['%' + ref + '%']);
    const refs = [...new Set([ref, ...catalog.orders.flatMap(o => [o.id, o.originalPoRef,
      o.sourcePoRef, o.dispatchRef, ...(o.correspondingPoRefs || [])]),
      ...schedule.flatMap(o => [o.orderRef, o.sourceRef, o.dispatchRef])].filter(Boolean))];
    const saved = await query(`SELECT order_kind, order_ref, status, dispatch_plan_id,
      reconciliation_order_state_id, reconciliation_blocked, updated_at, updated_by
      FROM scm_transport_schedule WHERE order_ref = ANY($1::text[]) ORDER BY order_ref`, [refs]);
    const reconciliation = await query(`SELECT id, source_order_ref, application_status,
      reconciliation_status, reconciled_at, quantity_summary->'targets' AS targets
      FROM scm_reconciliation_order_state WHERE source_order_ref = ANY($1::text[])
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(COALESCE(quantity_summary->'targets','{}')) target
        WHERE target = ANY($1::text[])) ORDER BY id DESC`, [refs]);
    const assignments = await query(`SELECT assignment.order_ref, assignment.planned_order_ref,
      assignment.plan_id, assignment.plan_date, plan.status
      FROM dispatch_plan_order_assignments assignment JOIN dispatch_plans plan ON plan.id=assignment.plan_id
      WHERE assignment.order_ref = ANY($1::text[]) OR assignment.planned_order_ref = ANY($1::text[])
      ORDER BY plan.id DESC`, [refs]);
    return {ref, schedule: schedule.map(({orderRef, sourceRef, sourceId, status, calculatedStatus,
      dispatchPlanned, scheduleId, updatedAt, reconciliationBlocked}) => ({orderRef, sourceRef,
      sourceId, status, calculatedStatus, dispatchPlanned, scheduleId, updatedAt, reconciliationBlocked})),
      catalog: catalog.orders.map(card), details, mirrors: mirrors.rows,
      saved: saved.rows, reconciliation: reconciliation.rows, assignments: assignments.rows};
  }, {rollback: true});
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDb();
}
