import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { query, withTransaction, closeDb } from './src/db.js';
import { config } from './src/config.js';
config.netsuite.directAccessEnabled = false;
const { loadDispatchOrdersForResponse } = await import('./src/server.js');
const { previewScmDependencyMutation } = await import('./src/scm-dependency-preview-service.js');
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='30s'");
    const orders = await loadDispatchOrdersForResponse({ type: 'SO', search: 'SOM06964', exactOrderRefs: ['SOM06964'], includeCompletedScmSearch: true });
    const order = orders.find(row => row.id === 'SOM06964');
    assert.ok(order);
    assert.equal(order.dispatchPlanningRestricted, false);
    assert.notEqual(order.dispatchCompletionStatus, 'completed');
    const preview = await previewScmDependencyMutation({ action: 'link_po', targetRef: 'SOM06964', payload: { poRef: 'POB04024' } },
      { id: '6d9d3766-27e1-4038-8cf8-d02b2ba1599e', username: 'testadmin' });
    assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
    const source = readFileSync('public/dispatch.js', 'utf8');
    const names = ['renderSelectedOrderActions', 'isReviewOnlyOrder', 'isDispatchPlanningRestricted', 'dispatchPlanningRestrictionText'];
    const functions = names.map(name => {
      const start = source.indexOf('function ' + name + '(');
      assert.ok(start >= 0);
      return source.slice(start, source.indexOf('\n}', start) + 2);
    }).join('\n');
    const env = { activeOrderType: 'SO', selectedOrder: () => order, selectedOrders: () => [order], escapeHtml: String,
      isScmReconciliationBlocked: () => false, groupedOrderTransitCoId: () => '', supportsTransitCoForOrder: () => false,
      displayDateTime: () => '', isSalesOrderReattempt: () => false, canConsolidatePick: () => false };
    const html = compileFunction(functions + '\nreturn renderSelectedOrderActions();', Object.keys(env))(...Object.values(env));
    assert.ok(html.includes('data-action="open-po-link-modal"'));
    assert.ok(!html.includes('Dispatch completed'));
    const item = order.items.find(row => Number(row.lineId) === 5137294);
    assert.equal(item.unit, 'SQFT'); assert.equal(Number(item.quantity), 28); assert.equal(Number(item.pieces), 7);
    const hold = (await query('SELECT * FROM sales_order_line_sync_holds WHERE sales_order_line_id=544895')).rows[0];
    assert.equal(hold.released_at, null); assert.equal(hold.source_snapshot.unit, 'SQFT');
    assert.equal((await query("SELECT tgenabled FROM pg_trigger WHERE tgname='preserve_held_sales_order_line_source'")).rows[0].tgenabled, 'O');
    return { orderRef: order.id, netSuiteStatus: order.netsuiteStatusText, dispatchCompletionStatus: order.dispatchCompletionStatus,
      planningRestricted: order.dispatchPlanningRestricted, poLinkPreviewAllowed: preview.allowed, linkPoButtonVisible: true,
      dispatchCompletedLabelAbsent: true, productionMutation: false,
      localLine: { sourceLineId: item.lineId, quantity: item.quantity, unit: item.unit, pieces: item.pieces, syncExcluded: true } };
  });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
