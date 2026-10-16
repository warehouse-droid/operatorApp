import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { fulfilledSalesDeliveryState, annotateFulfilledSalesOrders } from "../../../src/dispatch-fulfilled-so-policy.js";
import { scrubBilledSalesOrderFamilyFromPlan } from "../../../src/sales-order-reconciliation.js";

const row = { netsuite_id: 1, tranid: "SO-UNIT", status: "F", sales_order_type: "Delivery", identity_count: 1, source_identity_count: 1 };

test("ordinary unfinished local split keeps its existing planning behavior without receiving the exception", () => {
  const state = fulfilledSalesDeliveryState({ ...row, status: "B", netsuite_id: -1 });
  assert.equal(state.eligible, false);
  assert.equal(state.blocked, false);
});

test("property: only full NetSuite delivery without local completion or restrictions receives the allowance", () => {
  fc.assert(fc.property(fc.constantFrom("B", "E", "F", "G", "H"), fc.boolean(), fc.boolean(), fc.boolean(),
    fc.constantFrom("none", "hold", "reload", "missing", "review", "duplicate", "manual"),
    (status, driverCompleted, delivery, activeSplit, restriction) => {
      const source = { ...row, status, sales_order_type: delivery ? "Delivery" : "Pick-Up" };
      const candidate = { ...source, source, netsuite_id: -2, split_status: activeSplit ? "active" : "cancelled",
        local_yard_order_status: restriction === "hold" ? "Hold" : "Loaded",
        active_reload: restriction === "reload", netsuite_missing_at: restriction === "missing" ? "2026-09-15" : null,
        reconciliation_status: restriction === "review" ? "review" : "current",
        identity_count: restriction === "duplicate" ? 2 : 1, operationally_completed: restriction === "manual" };
      const expected = ["F", "G"].includes(status) && delivery && activeSplit && !driverCompleted && restriction === "none";
      assert.equal(fulfilledSalesDeliveryState(candidate, { driverCompleted }).eligible, expected);
    }), { seed: 20260915, numRuns: 600 });
});

test("property: partial fulfillment wording and local Loaded alone never grant NetSuite completion", () => {
  fc.assert(fc.property(fc.constantFrom("Pending Fulfillment", "Partially Fulfilled", "Pending Billing/Partially Fulfilled", "Unfulfilled"),
    fc.constantFrom(" ", "", "  "), (label, padding) => {
      const state = fulfilledSalesDeliveryState({ ...row, status: "E", status_text: `${padding}Sales Order : ${label}${padding}`, fulfillment_status: "fulfilled", local_yard_order_status: "Loaded" });
      assert.equal(state.fulfilled, false);
      assert.equal(state.eligible, false);
    }), { seed: 20260915, numRuns: 40 });
});

test("property: group allowance requires every exact member, and annotations retain immutable evidence", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), flags => {
    const states = new Map(flags.map((eligible, index) => [`so-${index}`, { fulfilled: true, eligible, locallyCompleted: !eligible, blocked: false }]));
    const input = [{ id: "SO-GROUP", type: "SO", childOrders: flags.map((_, index) => `SO-${index}`), completionEventId: "event-original", dispatchCompletedAt: "2026-09-01T00:00:00Z" }];
    const original = structuredClone(input);
    const [output] = annotateFulfilledSalesOrders(input, states);
    assert.equal(output.dispatchFulfilledSalesPlanningEligible, flags.every(Boolean));
    assert.equal(output.dispatchPlanningRestricted, flags.some(flag => !flag));
    assert.equal(output.completionEventId, "event-original");
    assert.equal(output.dispatchCompletedAt, flags.some(flag => !flag) ? "2026-09-01T00:00:00Z" : null);
    assert.deepEqual(input, original);
    assert.deepEqual(annotateFulfilledSalesOrders([output], states), [output]);
  }), { seed: 20260915, numRuns: 60 });
});

test("property: billed cleanup preserves only eligible siblings even when their source is removed", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), flags => {
    const children = flags.map((_, index) => ({ id: `SO-ROOT-S${index}`, type: "SO", originalOrderId: "SO-ROOT" }));
    const preserved = children.filter((_, index) => flags[index]).map(order => order.id);
    const plan = { orders: children, trucks: [{ loads: [{ orders: children, stops: children.map(order => ({ type: "drop", orderId: order.id })) }] }] };
    const result = scrubBilledSalesOrderFamilyFromPlan(plan, { canonicalRef: "SO-ROOT", familyRefs: children.map(order => order.id), preservedOrderRefs: preserved });
    assert.deepEqual(result.plan.orders.map(order => order.id), preserved);
    assert.deepEqual(result.plan.trucks[0].loads[0].stops.map(stop => stop.orderId), preserved);
    assert.deepEqual(result.plan.trucks[0].loads[0].orders.map(order => order.id), preserved);
  }), { seed: 20260915, numRuns: 60 });
});

test("billed cleanup keeps an eligible first group member and rewrites a dissolved group's stops", () => {
  for (const unrelated of [[], [{ id: "SO-OTHER", type: "SO", items: [{ quantity: 3 }] }]]) {
    const children = [{ id: "SO-ROOT-S2", type: "SO", originalOrderId: "SO-ROOT", items: [{ quantity: 2 }] },
      { id: "SO-ROOT-S1", type: "SO", originalOrderId: "SO-ROOT", items: [{ quantity: 1 }] }, ...unrelated];
    const group = { id: "GOB-FULFILLED", type: "SO", childOrders: children.map(order => order.id), childOrderDetails: children };
    const plan = { orders: [group], trucks: [{ loads: [{ orders: [group], stops: [{ orderId: group.id, type: "drop" }] }] }] };
    const result = scrubBilledSalesOrderFamilyFromPlan(plan, { canonicalRef: "SO-ROOT", familyRefs: ["SO-ROOT-S1", "SO-ROOT-S2"], preservedOrderRefs: ["SO-ROOT-S2"] });
    const retained = result.plan.orders[0];
    if (unrelated.length) {
      assert.deepEqual(retained.childOrders, ["SO-ROOT-S2", "SO-OTHER"]);
      assert.equal(result.plan.trucks[0].loads[0].stops[0].orderId, group.id);
    } else {
      assert.equal(retained.id, "SO-ROOT-S2");
      assert.equal(retained.items[0].quantity, 2);
      assert.equal(result.plan.trucks[0].loads[0].stops[0].orderId, "SO-ROOT-S2");
    }
    assert.deepEqual(result.plan.trucks[0].loads[0].orders[0], retained);
  }
});


test('packing-only reconciliation review never blocks planning at any packing stage', () => {
  for (const operator_status of ['open', 'preparing', 'partial_packed', 'packed']) {
    for (const reason of ['Unsubmitted Operator packing on SO-UNIT.',
      'Sales Order family reconciliation is blocked by an active operator packing draft on SO-UNIT.']) {
      const candidate = { ...row, status: 'B', operator_status, local_yard_order_status: 'Open',
        reconciliation_status: 'review', reconciliation_reason: reason, application_status: 'Reconcile Review' };
      assert.equal(fulfilledSalesDeliveryState(candidate).blocked, false, operator_status + reason);
      assert.equal(fulfilledSalesDeliveryState({ ...candidate, status: 'F' }).eligible, true);
      assert.equal(fulfilledSalesDeliveryState({ ...candidate, family_closed: true }).blocked, true);
      assert.equal(fulfilledSalesDeliveryState({ ...candidate, active_reload: true }).blocked, true);
      assert.equal(fulfilledSalesDeliveryState({ ...candidate, local_yard_order_status: 'Hold' }).blocked, true);
    }
  }
});

test('unknown, mixed, wrong-order and non-review reconciliation issues retain their planning restrictions', () => {
  for (const reconciliation_reason of ['', 'NetSuite quantity mismatch.',
    'Unsubmitted Operator packing on OTHER.',
    'Unsubmitted Operator packing on SO-UNIT. NetSuite quantity mismatch.']) {
    const candidate = { ...row, application_status: 'Reconcile Review', reconciliation_status: 'review', reconciliation_reason };
    assert.equal(fulfilledSalesDeliveryState(candidate).blocked, true, reconciliation_reason);
  }
  for (const reconciliation_status of ['missing', 'error']) {
    assert.equal(fulfilledSalesDeliveryState({ ...row, reconciliation_status,
      reconciliation_reason: 'Unsubmitted Operator packing on SO-UNIT.' }).blocked, true);
  }
});

test('property: packing stages preserve eligibility and local completion still prevents replanning', () => {
  fc.assert(fc.property(fc.constantFrom('B', 'E', 'F', 'G'),
    fc.constantFrom('open', 'preparing', 'partial_packed', 'packed'), fc.boolean(),
    (status, operator_status, driverCompleted) => {
      const candidate = { ...row, status, operator_status, reconciliation_status: 'review',
        reconciliation_reason: 'Unsubmitted Operator packing on SO-UNIT.', application_status: 'Reconcile Review' };
      const state = fulfilledSalesDeliveryState(candidate, { driverCompleted });
      assert.equal(state.blocked, false);
      assert.equal(state.eligible, ['F', 'G'].includes(status) && !driverCompleted);
      assert.equal(annotateFulfilledSalesOrders([{ id: 'SO-UNIT', type: 'SO', operatorStatus: operator_status }],
        new Map([['so-unit', state]]))[0].dispatchPlanningRestricted, driverCompleted);
    }), { seed: 20261012, numRuns: 100 });
});


test('planning projection clears packing-only Review fields and preserves packing and unrelated restrictions', () => {
  const packing = fulfilledSalesDeliveryState({ ...row, status: 'B', reconciliation_status: 'review',
    reconciliation_reason: 'Unsubmitted Operator packing on SO-UNIT.', application_status: 'Reconcile Review' });
  const original = { id: 'SO-UNIT', type: 'SO', operatorStatus: 'packed', reconciliationBlocked: true,
    reconciliationStatus: 'review', scm: { status: 'Reconcile Review', packingSlipRef: 'VENDOR' } };
  const [order] = annotateFulfilledSalesOrders([original], new Map([['so-unit', packing]]));
  assert.equal(order.dispatchPlanningRestricted, false); assert.equal(order.reconciliationBlocked, false);
  assert.equal(order.reconciliationStatus, 'current'); assert.equal(order.scm.status, 'Queued');
  assert.equal(order.operatorStatus, 'packed'); assert.equal(order.scm.packingSlipRef, 'VENDOR');
  assert.equal(original.reconciliationBlocked, true);
  const group = { ...original, id: 'GROUP', childOrders: ['SO-UNIT', 'OTHER'], childOrderDetails: [original] };
  const [blocked] = annotateFulfilledSalesOrders([group], new Map([['so-unit', packing], ['other', { blocked: true }]]));
  assert.equal(blocked.dispatchPlanningRestricted, true); assert.equal(blocked.reconciliationBlocked, true);
  assert.equal(fulfilledSalesDeliveryState({ ...row, tranid: '', reconciliation_status: 'review',
    reconciliation_reason: 'Unsubmitted Operator packing on SO-UNIT.' }).blocked, true);
});

test('an existing sales split may be planned when its source has packing-only Review', () => {
  const source = { ...row, status: 'B' };
  const split = { ...source, source, tranid: 'SO-UNIT-S1', netsuite_id: -12, split_status: 'active',
    application_status: 'Reconcile Review', reconciliation_status: 'review',
    reconciliation_reason: 'Unsubmitted Operator packing on SO-UNIT.' };
  assert.equal(fulfilledSalesDeliveryState(split).blocked, false);
  assert.equal(fulfilledSalesDeliveryState({ ...split, reconciliation_reason: 'Unsubmitted Operator packing on OTHER.' }).blocked, true);
});
