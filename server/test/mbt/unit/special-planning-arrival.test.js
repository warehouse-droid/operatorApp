import assert from 'node:assert/strict';
import test from 'node:test';
import { specialDispatchPlanning } from '../../../src/special-stock-planning.js';
import { specialPlanningStatus } from '../../../public/special-stock-case-status.js';

const detail = { id: 95, salesOrderId: 1033108, salesOrderRef: 'SOB121882',
  purchaseOrderId: 995310, purchaseOrderRef: 'POB03883', purchaseOrderReference: 'SN1400411' };
const plan = stops => ({ id: 344, planDate: '2026-10-02', status: 'confirmed',
  trucks: [{ plate: 'CE94489', loads: [{ name: 'Load 3', stops }] }] });

test('PO planning shows the drop arrival, not the earlier vendor pickup', () => {
  const stops = [
    { type: 'pick', orderRefs: ['SN1400411'], timing: { arrival: 922 } },
    { type: 'drop', orderId: 'SN1400411', timing: { arrival: 1021 } }
  ];
  for (const visits of [stops, [...stops].reverse()]) {
    const planning = specialDispatchPlanning(detail, [plan(visits)]);
    assert.equal(planning.purchaseOrder.planned, true);
    assert.equal(planning.purchaseOrder.plans[0].estimatedArrivalMinute, 1021);
    const html = specialPlanningStatus({ ...detail, dispatchPlanning: planning }, false, { showOrderPreviews: true });
    assert.match(html, /special-planning-order is-planned/);
    assert.match(html, /Planned \(2026-10-02\)/);
    assert.match(html, /Est\. arrival: 2026-10-02 17:01/);
    assert.doesNotMatch(html, /15:22/);
    assert.match(html, /special-planning-order"><span><strong>SO SOB121882/);
  }
});

test('group and split deliveries retain the ETA; pickup-only plans do not invent one', () => {
  const grouped = plan([{ type: 'delivery', orderId: 'GROUP', timing: { arrival: 1080 } }]);
  grouped.orders = [{ id: 'GROUP', childOrderDetails: [{ id: 'SN1400411-S1', originalOrderId: 'SN1400411' }] }];
  assert.equal(specialDispatchPlanning(detail, [grouped]).purchaseOrder.plans[0].estimatedArrivalMinute, 1080);
  const planning = specialDispatchPlanning(detail, [plan([{ type: 'pick', orderId: 'SN1400411', timing: { arrival: 922 } }])]);
  assert.equal(planning.purchaseOrder.plans[0].estimatedArrivalMinute, null);
  assert.match(specialPlanningStatus({ ...detail, dispatchPlanning: planning }, false, { showOrderPreviews: true }), /Est\. arrival: Not available/);
  assert.equal(specialDispatchPlanning(detail, [{ ...grouped, status: 'cancelled' }]).anyPlanned, false);
});

test('midnight, overnight, and missing arrival values are displayed accurately', () => {
  for (const [arrival, expected] of [[0, '00:00'], [1501, '01:01 (+1 day)'], [null, 'Not available'], ['', 'Not available']]) {
    const planning = specialDispatchPlanning(detail, [plan([{ type: 'drop', orderId: 'SN1400411', timing: { arrival } }])]);
    const html = specialPlanningStatus({ ...detail, dispatchPlanning: planning }, false, { showOrderPreviews: true });
    assert.ok(html.includes(expected));
  }
});
