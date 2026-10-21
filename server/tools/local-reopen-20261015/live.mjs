import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { query, withTransaction, closeDb } from './src/db.js';
import { config } from './src/config.js';
import { locallyReopenedSalesOrderIds } from './src/local-sales-order-reopen.js';
import { isBilledSalesOrderIdentifier } from './src/sales-order-reconciliation-repository.js';
import { listDeliveryOrders } from './src/delivery-repository.js';
import { previewOperatorOrderReopen } from './src/operator-order-reopen-repository.js';
import { previewScmDependencyMutation } from './src/scm-dependency-preview-service.js';
import { getSalesOrderPoAllocationOptions, listDispatchOrders } from './src/dispatch-repository.js';
import { overlayFulfilledSalesDeliveryPlanning } from './src/dispatch-fulfilled-so-repository.js';

// This diagnostic process uses current local state and performs no NetSuite calls.
config.netsuite.directAccessEnabled = false;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const beforeRelease = process.env.BILLED_REOPEN_BEFORE === '1';
try {
  const health = await fetch('http://127.0.0.1:3000/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const page = await fetch('http://127.0.0.1:3000/dispatch/planning');
  assert.equal(page.status, 200);
  if (!beforeRelease) { assert.ok((await page.text()).includes('/dispatch.js?v=20261015-local-reopen-v2')); }
  const asset = await fetch('http://127.0.0.1:3000/dispatch.js?v=20261015-local-reopen-v2');
  assert.equal(await asset.text(), readFileSync('public/dispatch.js', 'utf8'));
  assert.equal((await fetch('http://127.0.0.1:3000/api/control/operator-orders/SOM06964/reopen-preview')).status, 401);
  const evidence = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const snapshot = async () => (await query(`SELECT to_jsonb(s) AS header,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_order_lines l WHERE l.sales_order_id=s.netsuite_id) AS lines
      FROM sales_orders s WHERE tranid='SOM06964'`)).rows;
    const before = await snapshot();
    assert.equal(before.length, 1);
    const actorRow = (await query("SELECT id,role,roles,yard_location_ids FROM operators WHERE active AND (role='admin' OR roles @> ARRAY['admin']::text[]) ORDER BY id LIMIT 1")).rows[0];
    assert.ok(actorRow, 'Read-only preview requires an existing authorized Control actor');
    const actor = { id: actorRow.id, role: actorRow.role, roles: actorRow.roles, yardLocationIds: actorRow.yard_location_ids };
    const reopen = await previewOperatorOrderReopen({ orderRef: 'SOM06964', actor });
    const link = await previewScmDependencyMutation({ action: 'link_po', targetRef: 'SOM06964', payload: { poRef: '' } });
    const options = await getSalesOrderPoAllocationOptions('SOM06964');
    const orders = await overlayFulfilledSalesDeliveryPlanning(await listDispatchOrders({ type: 'SO', search: 'SOM06964', includeFulfilledSalesDeliveries: true }));
    const order = orders.find(row => row.id === 'SOM06964');
    assert.ok(order);
    const source = readFileSync('public/dispatch.js', 'utf8');
    const functions = ['renderSelectedOrderActions', 'isReviewOnlyOrder', 'isDispatchPlanningRestricted', 'dispatchPlanningRestrictionText'].map(name => {
      const start = new RegExp('^function ' + name + '\\(', 'm').exec(source);
      assert.ok(start);
      const rest = source.slice(start.index), end = /^\}/m.exec(rest);
      assert.ok(end);
      return rest.slice(0, end.index + 1);
    }).join('\n');
    const dependencies = {
      activeOrderType: 'SO', selectedOrder: () => order, selectedOrders: () => [order], escapeHtml: value => String(value || ''),
      isScmReconciliationBlocked: () => false, groupedOrderTransitCoId: () => '', supportsTransitCoForOrder: () => false,
      displayDateTime: () => '', isSalesOrderReattempt: () => false, canConsolidatePick: () => false
    };
    const html = compileFunction(functions + '\nreturn renderSelectedOrderActions();', Object.keys(dependencies))(...Object.values(dependencies));
    const linkPoVisible = html.includes('data-action="open-po-link-modal"');
    assert.equal(reopen.allowed, !beforeRelease, JSON.stringify(reopen.blockers));
    assert.equal(link.allowed, true, JSON.stringify(link.blockers));
    assert.equal(linkPoVisible, !beforeRelease);
    const reopened = (await locallyReopenedSalesOrderIds([1049213])).has('1049213');
    const operatorAccessAllowed = !(await isBilledSalesOrderIdentifier('SOM06964'));
    assert.equal(operatorAccessAllowed, reopened);
    assert.equal(order.localOrderReopened, reopened);
    if (reopened) {
      assert.notEqual(order.dispatchCompletionStatus, 'completed');
      assert.equal(order.dispatchFulfilledSalesPlanningEligible, true);
      assert.equal(order.dispatchPlanningRestricted, false);
    }
    const active = await listDeliveryOrders({locationId:26,status:'active',orderType:'sales_order',allowedOperatorYards:[26]});
    const operatorActivePoolVisible = active.some(row => row.tranid === 'SOM06964');
    assert.equal(operatorActivePoolVisible, reopened);
    assert.equal(options.allocations.length, 5, 'Preserve the two previously linked POs');
    const after = await snapshot();
    assert.equal(hash(before), hash(after));
    return { orderRef: order.id, netsuiteStatus: before[0].header.status_text,
      operatorStatus: before[0].header.operator_status, fulfillmentStatus: before[0].header.fulfillment_status,
      reopenAllowed: reopen.allowed, poLinkPreviewAllowed: link.allowed, linkPoVisible,
      salesLineCount: options.salesLines.length, existingPoAllocations: options.allocations.length,
      localOrderReopened: reopened, operatorAccessAllowed, operatorActivePoolVisible, inspectionReadOnly: true, orderDataUnchanged: true };
  });
  console.log(JSON.stringify({ health: true, servedAssetVerified: true, anonymousReopenBlocked: true, ...evidence }));
} finally { await closeDb(); }
