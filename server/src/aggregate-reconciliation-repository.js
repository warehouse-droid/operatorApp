import { query, withTransaction } from './db.js';
import { AGGREGATE_ITEM_PATTERN, AGGREGATE_SOURCE_FILTER, aggregateNightlySchedule } from './aggregate-reconciliation.js';
import { createScmReconciliationRun, getScmReconciliationSettings } from './scm-reconciliation-repository.js';

export async function listPendingAggregateReconciliationSources() {
  const result = await query(`SELECT 'SO'::text AS kind, sales_order.netsuite_id, sales_order.tranid
    FROM sales_orders sales_order
    WHERE sales_order.netsuite_id > 0 AND COALESCE(sales_order.is_test_fixture, false) = false
      AND sales_order.netsuite_active IS NOT FALSE
      AND (upper(btrim(COALESCE(sales_order.status, ''))) = 'B'
        OR (NULLIF(btrim(sales_order.status), '') IS NULL
          AND btrim(COALESCE(sales_order.status_text, '')) ~* '^(Sales Order : )?Pending Fulfillment$'))
      AND EXISTS (SELECT 1 FROM sales_order_lines line
        JOIN inventory_items item ON item.item_id = line.item_id
        WHERE line.sales_order_id = sales_order.netsuite_id
          AND line.netsuite_active IS NOT FALSE AND line.quantity > 0
          AND regexp_replace(btrim(item.item_name), '[[:space:]]+', ' ', 'g') ~* $1)
    ORDER BY sales_order.netsuite_id`, [AGGREGATE_ITEM_PATTERN]);
  return result.rows.map(row => ({ kind: row.kind, id: Number(row.netsuite_id), tranid: row.tranid }));
}

/** Claim once per local date; row lock and unique index also protect multiple app workers. */
export async function claimAggregateNightlyRun({ now = new Date() } = {}) {
  return withTransaction(async () => {
    await query('SELECT singleton_id FROM scm_reconciliation_settings WHERE singleton_id=1 FOR UPDATE');
    const settings = await getScmReconciliationSettings();
    const schedule = aggregateNightlySchedule(settings, settings.aggregateNightlyLastRun, now);
    if (schedule.reason !== 'due') { return { started: false, reason: schedule.reason }; }
    const active = await query("SELECT id FROM scm_reconciliation_runs WHERE status IN ('queued','running') LIMIT 1");
    if (active.rows.length) { return { started: false, reason: 'reconciliation_active' }; }
    const run = await createScmReconciliationRun({ triggerSource: 'nightly', scope: 'SO', soOrderType: 'all',
      sourceFilter: AGGREGATE_SOURCE_FILTER, scheduledLocalDate: schedule.localDate,
      dryRun: false, applyUnambiguous: true, requestedBy: 'nightly-aggregate' });
    return { started: true, run };
  });
}
