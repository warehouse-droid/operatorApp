import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../src/db.js';
import { getOrderDependencyOptions, enrichDispatchOrdersWithDependencies } from '../src/order-dependency-repository.js';
import { aggregateGlobalGroup } from '../src/dispatch-delivery-group-repository.js';
import { rollupGroupedSalesOrderReconciliation } from '../src/sales-order-reconciliation.js';
import { dispatchRequiredPickupVisitLocations, validateDispatchPickupVisits } from '../src/dispatch-pickup-visits.js';
import { reconcileDependencyManagedPickups } from '../src/scm-dependency-plan-reconciler.js';

try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='30s'");
    const targetRef = 'GOM-6635-6636';
    const transferOrderRef = 'TOB01135';
    const parameters = { dispatchTargetRef: targetRef, transferOrderRef, planDate: '2026-09-23' };
    const uppercase = await getOrderDependencyOptions(parameters);
    const lowercase = await getOrderDependencyOptions({ ...parameters, transferOrderRef: transferOrderRef.toLowerCase() });
    assert.deepEqual(lowercase, uppercase, 'TO matching differs by case');
    const stored = (await query('SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1', [targetRef])).rows[0]?.full_order;
    assert.ok(stored, 'Reported group no longer exists');
    const [enriched] = await enrichDispatchOrdersWithDependencies([stored]);
    assert.ok(enriched.directPickupManifest.some(entry => entry.transferOrderRef === transferOrderRef));
    const grouped = aggregateGlobalGroup(enriched, enriched.childOrderDetails);
    const reconciled = rollupGroupedSalesOrderReconciliation(grouped, grouped.childOrderDetails);
    const locations = dispatchRequiredPickupVisitLocations(reconciled);
    assert.ok(locations.includes('2967'), 'TO pickup location was lost');
    const plan = { orders: [reconciled], trucks: [{ id: 'READ-ONLY-PROBE', loads: [{ id: 'READ-ONLY-PROBE', stops: [
      { id: 'READ-ONLY-DROP', type: 'drop', orderId: targetRef }
    ] }] }] };
    const preview = reconcileDependencyManagedPickups({ plan, enrichedOrders: [reconciled], affectedTargetRefs: [targetRef] });
    assert.deepEqual(validateDispatchPickupVisits(preview), []);
    assert.ok(preview.trucks[0].loads[0].stops.some(stop => stop.type === 'pick' && stop.location === '2967'));
    return { passed: true, readOnly: true, targetRef, transferOrderRef, caseInsensitiveMatch: true,
      pickupLocations: locations, generatedRouteValid: true, businessDataChanged: false };
  });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
