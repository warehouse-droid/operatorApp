// Read-only live verification: never submits requests, acknowledges alerts or creates orders.
import assert from 'node:assert/strict';
const root = process.cwd();
const {query, withTransaction, closeDb} = await import(root + '/src/db.js');
const {getSmartScmSettings} = await import(root + '/src/smart-scm-repository.js');
const {regularStockAlerts} = await import(root + '/src/regular-stock-request-service.js');
const {getScmStockRequest, listScmStockRequests} = await import(root + '/src/stock-request-repository.js');
const {config} = await import(root + '/src/config.js');
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const migration = await query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='239_regular_stock_approval_workflow.sql'");
    assert.equal(migration.rows[0].n, 1);
    const settings = await getSmartScmSettings();
    assert.ok(Number.isFinite(settings.regularStockLeadHours) && settings.regularStockLeadHours >= 0);
    const scm = await regularStockAlerts({scm: true});
    const expected = await query("SELECT count(*)::int AS n FROM sales_stock_requests r WHERE r.workflow_version=2 AND r.request_type='regular' AND EXISTS(SELECT 1 FROM sales_stock_request_lines l WHERE l.request_id=r.id AND l.status='submitted')");
    assert.equal(scm.manualReview, expected.rows[0].n);
    const rows = (await query('SELECT id,requested_by,destination_location_id FROM sales_stock_requests ORDER BY id DESC LIMIT 1')).rows;
    let legacyDetailRead = false;
    if (rows.length) {
      const row = rows[0];
      const detail = await getScmStockRequest(row.id);
      assert.equal(detail.id, Number(row.id));
      legacyDetailRead = detail.workflowVersion === 1;
      const sales = await regularStockAlerts({operatorId: row.requested_by, authorizedDestinationLocationIds: [Number(row.destination_location_id)]});
      assert.equal(sales.total, sales.requests.length);
      for (const request of sales.requests) {
        const owner = (await query('SELECT requested_by,destination_location_id FROM sales_stock_requests WHERE id=$1', [request.id])).rows[0];
        assert.equal(owner.requested_by, row.requested_by);
        assert.equal(Number(owner.destination_location_id), Number(row.destination_location_id));
      }
    } else {
      assert.equal((await regularStockAlerts()).total, 0);
    }
    for (const queue of ['request', 'approved', 'pending_to', 'rejected', 'closed']) {
      assert.ok(Array.isArray(await listScmStockRequests({queue, limit: 1})));
    }
    for (const table of ['regular_stock_handoffs', 'regular_stock_decision_reads', 'regular_stock_so_line_owners',
      'regular_stock_replenishments', 'regular_stock_replenishment_requests', 'regular_stock_replenishment_runs']) {
      await query('SELECT 1 FROM ' + table + ' LIMIT 1');
    }
    return {readOnly: true, migrationApplied: true, leadHours: settings.regularStockLeadHours,
      scmAlertCountVerified: true, salesAlertScopeVerified: true, requestQueuesVerified: 5,
      legacyDetailRead, tablesVerified: 6, liveExecutionEnabled: config.smartScm.liveExecutionEnabled,
      netSuiteOrderWrites: 0};
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
