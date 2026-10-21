// One-time operational catch-up for the user's named request. The delivery
// change happened before rollout; append a notice without changing its history.
import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from './src/db.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { listSpecialDeliveryMethodAlerts } from './src/special-delivery-method-alerts.js';

const snapshotSql = `SELECT jsonb_build_object('request', to_jsonb(request), 'case', to_jsonb(special),
  'lines', (SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id) FROM sales_special_stock_lines line WHERE line.request_id=request.id),
  'orders', (SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id) FROM sales_special_stock_order_lines line WHERE line.request_id=request.id),
  'handoff', (SELECT to_jsonb(handoff) FROM sales_special_stock_handoffs handoff WHERE handoff.request_id=request.id)) AS snapshot
  FROM sales_stock_requests request JOIN sales_special_stock_cases special ON special.request_id=request.id WHERE request.id=125`;

try {
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    const locked = await query('SELECT id FROM sales_stock_requests WHERE id=125 FOR UPDATE');
    assert.equal(locked.rowCount, 1);
    const before = (await query(snapshotSql)).rows[0].snapshot;
    const source = (await query(`SELECT * FROM sales_special_stock_events
      WHERE id=1059 AND request_id=125 AND event_type='special_delivery_method_updated' FOR SHARE`)).rows[0];
    assert.ok(source);
    assert.equal(source.details.before, 'vendor_pickup');
    assert.equal(source.details.fulfillmentMethod, 'yard_pickup');
    assert.ok(source.details.changeId);
    const detail = await getSpecialStockCase(125, { audience: 'sales', authorizedStoreLocationIds: [1] });
    assert.equal(detail.requestRef, 'SPREQ-000041');
    assert.equal(detail.fulfillmentMethod, 'yard_pickup');
    assert.equal(detail.storeName, '3445');
    assert.equal(detail.operationalYardLocationId, 1);
    assert.equal(detail.salesOrderRef, 'SOB122143');
    assert.equal(detail.purchaseOrderRef, 'POB03999');
    assert.equal(detail.purchaseOrderReference, 'SN1402193');
    const existing = await query(`SELECT id FROM sales_special_stock_events WHERE request_id=125
      AND event_type='special_delivery_method_updated' AND details->>'notifyTeams'='true'
      AND (id=$1 OR details->>'changeId'=$2) ORDER BY id`, [source.id, source.details.changeId]);
    assert.ok(existing.rowCount <= 1, 'The change must have only one team notice');
    let noticeId = existing.rows[0]?.id;
    if (!noticeId) {
      const details = { ...source.details, notifyTeams: true, yardName: detail.storeName,
        operationalYardLocationId: detail.operationalYardLocationId,
        salesOrderRef: detail.salesOrderRef, purchaseOrderRef: detail.purchaseOrderRef,
        purchaseOrderReference: detail.purchaseOrderReference,
        notificationBackfill: { sourceEventId: Number(source.id), originalChangedAt: source.created_at,
          reason: 'SPREQ-000041 changed before the alert feature was deployed; queue the requested SCM and Dispatch notice.' } };
      const inserted = await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
        VALUES(125,'special_delivery_method_updated',NULL,'scm',$1::jsonb) RETURNING id`, [JSON.stringify(details)]);
      noticeId = inserted.rows[0].id;
    }
    const after = (await query(snapshotSql)).rows[0].snapshot;
    assert.deepEqual(after, before, 'Queuing a notice must preserve the request, case, lines, orders and handoff');
    assert.deepEqual((await query('SELECT details FROM sales_special_stock_events WHERE id=1059')).rows[0].details, source.details);
    // Read both recipient feeds without creating acknowledgement receipts.
    for (const audience of ['scm', 'dispatch']) {
      const feed = await listSpecialDeliveryMethodAlerts({ operatorId: source.actor_id, audience });
      assert.ok(feed.alerts.some(alert => alert.id === Number(noticeId)), `${audience} must see the notice`);
    }
    return { requestRef: detail.requestRef, method: detail.fulfillmentMethod, yard: detail.storeName,
      sourceEventId: Number(source.id), noticeEventId: Number(noticeId), audiences: ['scm', 'dispatch'],
      created: !existing.rowCount, requestAndOrdersPreserved: true, originalEventPreserved: true };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
process.exit(0);
