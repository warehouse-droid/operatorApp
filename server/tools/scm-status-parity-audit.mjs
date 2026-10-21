import { closeDb, query, withTransaction } from '../src/db.js';
import { listScmSchedule } from '../src/dispatch-repository.js';
import { getScmPurchaseOrderCatalogOrder, listScmPurchaseOrderCatalog } from '../src/scm-purchase-order-catalog-repository.js';

try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await query("SET LOCAL statement_timeout = '45s'");
    const mirrors = (await query(`SELECT po.netsuite_id, po.tranid, po.dispatch_ref,
      po.initial_scm_status, po.status, po.status_text, po.netsuite_active,
      COALESCE(NULLIF(btrim(po.dispatch_ref), ''), po.tranid) AS schedule_ref,
      schedule.status AS saved_status, schedule.group_ref,
      split.id IS NOT NULL AS is_split
      FROM purchase_orders po
      LEFT JOIN scm_transport_schedule schedule ON schedule.order_kind='PO'
        AND lower(schedule.order_ref)=lower(COALESCE(NULLIF(btrim(po.dispatch_ref), ''), po.tranid))
      LEFT JOIN dispatch_scm_po_splits split ON split.split_po_id=po.netsuite_id AND split.status='active'
      WHERE po.netsuite_active=true ORDER BY po.netsuite_id`)).rows;
    const mirrorByRef = new Map();
    for (const row of mirrors) {
      for (const ref of [row.tranid, row.dispatch_ref].filter(Boolean)) mirrorByRef.set(ref.toLowerCase(), row);
    }
    const storedCatalog = new Map((await query(`SELECT lower(order_ref) AS ref,
      summary->'scm'->>'status' AS status FROM scm_purchase_order_catalog_entries WHERE eligible=true`))
      .rows.map(row => [row.ref, row.status]));
    const orders = [];
    let cursor = '';
    do {
      const page = await listScmPurchaseOrderCatalog({cursor, limit: 200});
      orders.push(...page.orders);
      cursor = page.nextCursor;
    } while (cursor);
    const schedule = [];
    if (process.env.SCM_STATUS_BATCHED === '1') {
      const refs = [...new Set([...orders.map(o => o.id), ...mirrors.map(row => row.schedule_ref)].filter(Boolean))];
      for (let index = 0; index < refs.length; index += 201) {
        schedule.push(...await listScmSchedule({kind: 'PO', view: 'blanket', exactRefs: refs.slice(index, index + 201)}));
      }
    } else {
      schedule.push(...await listScmSchedule({search: '%', kind: 'PO', view: 'blanket'}));
    }
    const byRef = new Map(schedule.map(row => [row.orderRef.toLowerCase(), row]));
    const mismatches = [];
    const missing = [];
    const queuedHold = [];
    const excludedQueuedHold = [];
    let compared = 0;
    let detailsChecked = 0;
    const reportDetailProgress = () => {
      detailsChecked += 1;
      if (detailsChecked % 50 === 0) console.error(JSON.stringify({detailsChecked}));
    };
    for (const order of orders) {
        const mirror = mirrorByRef.get(order.id.toLowerCase());
        const row = byRef.get(order.id.toLowerCase()) || byRef.get(mirror?.schedule_ref?.toLowerCase());
        if (!row) {
          missing.push({ref: order.id, status: order.scm?.status, group: mirror?.group_ref || '',
            activeMirror: Boolean(mirror), mirrorStatus: mirror?.status_text});
          if ([order.scm?.status, storedCatalog.get(order.id.toLowerCase())].some(value => ['queued', 'hold'].includes(String(value || '').toLowerCase()))) {
            const detail = await getScmPurchaseOrderCatalogOrder(order.id);
            reportDetailProgress();
            const passed = order.scm?.status === detail?.scm?.status;
            const record = {ref: order.id, kind: order.isScmSplit ? 'split' : 'source',
              card: order.scm?.status, detail: detail?.scm?.status, group: mirror?.group_ref || '',
              mirrorStatus: mirror?.status_text, passed};
            excludedQueuedHold.push(record);
            if (!passed) mismatches.push(record);
          }
          continue;
        }
        compared += 1;
        if (row.calculatedStatus !== order.scm?.status || row.dispatchPlanned !== order.dispatchPlanned) {
          mismatches.push({ref: order.id, source: order.originalPoRef,
            split: order.isScmSplit, schedule: row.calculatedStatus, catalog: order.scm?.status,
            schedulePlanned: row.dispatchPlanned, catalogPlanned: order.dispatchPlanned,
            scheduleId: row.scheduleId});
        }
        if ([order.scm?.status, row.calculatedStatus, mirror?.saved_status, storedCatalog.get(order.id.toLowerCase())].some(value => ['queued', 'hold'].includes(String(value || '').toLowerCase()))) {
          const detail = await getScmPurchaseOrderCatalogOrder(order.id);
          reportDetailProgress();
          const passed = detail?.scm?.status === row.calculatedStatus && order.scm?.status === row.calculatedStatus
            && detail?.dispatchPlanned === row.dispatchPlanned && order.dispatchPlanned === row.dispatchPlanned;
          const record = {ref: order.id, kind: order.isScmSplit ? 'split' : 'source',
            scheduleRef: row.orderRef, savedStatus: mirror?.saved_status,
            initialStatus: mirror?.initial_scm_status, schedule: row.calculatedStatus,
            card: order.scm?.status, detail: detail?.scm?.status, planned: row.dispatchPlanned, passed};
          queuedHold.push(record);
          if (!passed && !mismatches.some(item => item.ref === order.id)) mismatches.push(record);
        }
    }
    const catalogRefs = new Set(orders.map(order => order.id.toLowerCase()));
    const unindexedQueuedHold = [...byRef.values()].filter(row => ['Queued', 'Hold'].includes(row.calculatedStatus)
      && !catalogRefs.has(row.orderRef.toLowerCase())).map(row => ({ref: row.orderRef, status: row.calculatedStatus}));
    const retiredRefs = new Set((await query(`SELECT lower(COALESCE(NULLIF(btrim(dispatch_ref), ''),tranid)) AS ref
      FROM purchase_orders WHERE netsuite_active=false
      AND lower(COALESCE(NULLIF(btrim(dispatch_ref), ''),tranid))=ANY($1::text[])`,
      [unindexedQueuedHold.map(row => row.ref.toLowerCase())])).rows.map(row => row.ref));
    const pendingApprovalRefs = new Set(mirrors.filter(row => row.status === 'A'
      || /pending(?:\s+supervisor)?\s+approval/i.test(row.status_text || ''))
      .flatMap(row => [row.tranid, row.dispatch_ref].filter(Boolean).map(ref => ref.toLowerCase())));
    const pendingApprovalQueuedHold = unindexedQueuedHold.filter(row => pendingApprovalRefs.has(row.ref.toLowerCase()));
    const missingQueuedHold = unindexedQueuedHold.filter(row => !retiredRefs.has(row.ref.toLowerCase())
      && !pendingApprovalRefs.has(row.ref.toLowerCase()));
    return {scanned: orders.length, activeMirrorRows: mirrors.length,
      scheduleRows: byRef.size, compared, mismatches, missingQueuedHold,
      queuedHoldChecked: queuedHold.length,
      queuedHoldSources: queuedHold.filter(row => row.kind === 'source').length,
      queuedHoldSplits: queuedHold.filter(row => row.kind === 'split').length,
      queuedHoldFailures: queuedHold.filter(row => !row.passed).length, queuedHold,
      excludedQueuedHold, excludedQueuedHoldFailures: excludedQueuedHold.filter(row => !row.passed).length,
      retiredQueuedHold: unindexedQueuedHold.filter(row => retiredRefs.has(row.ref.toLowerCase())),
      pendingApprovalQueuedHold,
      unmatchedCatalogCount: missing.length, unmatchedCatalog: missing};
  }, {rollback: true});
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDb();
}
