import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { normalizeSpecialSupplyResponse } from '../../../src/special-stock-request-domain.js';
import { specialStage, parseStages } from '../../../public/special-stock-workflow.js';
import { specialPlanningStatus } from '../../../public/special-stock-case-status.js';

test('Low inventory is a supported available supply response without an ETA', () => {
  const response = normalizeSpecialSupplyResponse({ supplyStatus: 'low_inventory', availabilityMode: 'no_projection', vendorId: 123, vendorName: 'Vendor', vendorYard: 'Yard' });
  assert.equal(response.supplyStatus, 'low_inventory');
  assert.equal(response.availableDate, null);
});

test('Pending Update takes priority over customer confirmation and remains filterable', () => {
  assert.equal(specialStage({ pendingUpdate: true, hasPendingSalesDecision: true }), 'pending_update');
  assert.deepEqual(parseStages('pending_update,new_enquiry'), ['pending_update', 'new_enquiry']);
  fc.assert(fc.property(fc.boolean(), fc.boolean(), (closed, operationallyComplete) => {
    assert.equal(specialStage({ pendingUpdate: true, closed, operationallyComplete }), closed ? 'closed' : operationallyComplete ? 'completed' : 'pending_update');
  }), { seed: 20261002, numRuns: 30 });
});

const detail = { salesOrderId: 1, salesOrderRef: 'SO1', purchaseOrderId: 2, purchaseOrderRef: 'PO2', purchaseOrderApproved: true,
  dispatchPlanning: { anyPlanned: true, salesOrder: { planned: true, plans: [{ planDate: '2099-01-02' }] }, purchaseOrder: { planned: true, plans: [] } } };
test('Sales sees separate PO and delivery SO planning containers in detail and queue', () => {
  for (const compact of [false, true]) {
    const html = specialPlanningStatus({ ...detail, fulfillmentMethod: 'mbt_delivery' }, compact, { audience: 'sales' });
    assert.match(html, /PO planning/); assert.match(html, /SO planning/);
    assert.equal((html.match(/special-planning-order is-planned/g) || []).length, 2);
  }
});

test('Yard pickup shows fulfillment instead of SO planning; only fulfilled SO is green', () => {
  for (const status of ['Pending Fulfillment', 'Partially Fulfilled', 'Pending Billing/Partially Fulfilled', 'Closed', 'Fulfilled']) {
    const html = specialPlanningStatus({ ...detail, fulfillmentMethod: 'yard_pickup', salesOrderFulfillmentStatus: status }, false, { audience: 'sales' });
    assert.match(html, /SO fulfillment/); assert.doesNotMatch(html, /SO planning/);
    assert.equal((html.match(/special-planning-order is-planned/g) || []).length, status === 'Fulfilled' ? 2 : 1, status);
  }
});

test('Sales reuses the SCM order section with SO preview only; SCM also shows the PO reference', () => {
  const input = { ...detail, id: 7, fulfillmentMethod: 'mbt_delivery', purchaseOrderReference: 'SN1401999' };
  const sales = specialPlanningStatus(input, false, { audience: 'sales', showOrderPreviews: true });
  assert.match(sales, /special-planning-documents/);
  assert.match(sales, /data-special-document="sales_order"/);
  assert.doesNotMatch(sales, /data-special-document="purchase_order"/);
  const scm = specialPlanningStatus(input, false, { showOrderPreviews: true });
  assert.match(scm, /PO2 \/ SN1401999/);
  assert.match(scm, /data-special-document="purchase_order"/);
  assert.match(specialPlanningStatus(input, true), /PO2 \/ SN1401999/);
  const vendor = specialPlanningStatus({ ...input, fulfillmentMethod: 'vendor_pickup', salesOrderStatus: 'Pending Fulfillment' }, false, { audience: 'sales' });
  assert.match(vendor, /Awaiting vendor pickup/); assert.doesNotMatch(vendor, /Pending Fulfillment|SO planning|SO fulfillment/);
  assert.equal((vendor.match(/special-planning-order is-planned/g) || []).length, 1);
});

test('Stocking purchase details show the optional customer to Sales and SCM and escape it', () => {
  const context = vm.createContext({ window: {}, Intl });
  for (const file of ['regular-stock-ui.js', 'regular-stock-purchase.js']) vm.runInContext(readFileSync(`public/${file}`, 'utf8'), context);
  const request = { workflowVersion: 2, requestRef: 'REQ', destinationName: 'Yard', status: 'submitted', lines: [],
    regular: { deliveryMethod: 'stocking', stockingType: 'purchase', customerName: 'Customer <North>' } };
  for (const scm of [false, true]) {
    const html = context.window.RegularPurchaseUI.detail(request, scm);
    assert.match(html, /Customer &lt;North&gt;/); assert.doesNotMatch(html, /Customer <North>/);
  }
  request.regular.customerName = '';
  assert.doesNotMatch(context.window.RegularPurchaseUI.detail(request), /undefined|null/);
});

test('Resolved stocking transfer details retain the optional customer name', () => {
  const context = vm.createContext({ window: { RegularStockResolution: { result: () => '<p>Resolved</p>' } }, Intl });
  vm.runInContext(readFileSync('public/regular-stock-ui.js', 'utf8'), context);
  assert.match(context.window.RegularStockUI.summary({ workflowVersion: 2, regular: { deliveryMethod: 'stocking', stockingType: 'transfer', customerName: 'Resolved customer', resolution: {} } }), /Resolved customer/);
});
