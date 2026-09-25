import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveSpecialCaseStage, normalizeSpecialSalesDecision, normalizeSpecialCaseDraft,
  normalizeSpecialSalesOrderDraft } from '../../../src/special-stock-request-domain.js';

test('seven stages keep production waiting above order milestones and completion above attention', () => {
  assert.equal(deriveSpecialCaseStage({ submitted: true }), 'new_enquiry');
  assert.equal(deriveSpecialCaseStage({ submitted: true, hasPendingSalesDecision: true }), 'await_customer_confirmation');
  assert.equal(deriveSpecialCaseStage({ waitingForProduction: true, salesOrderId: 1, purchaseOrderId: 2 }), 'wait_for_production');
  assert.equal(deriveSpecialCaseStage({ salesOrderId: 1 }), 'confirmed');
  assert.equal(deriveSpecialCaseStage({ salesOrderId: 1, purchaseOrderId: 2, fulfillmentMethod: 'yard_pickup' }), 'dispatch_arrangement');
  assert.equal(deriveSpecialCaseStage({ salesOrderId: 1, purchaseOrderId: 2, fulfillmentMethod: 'vendor_pickup' }), 'confirmed');
  assert.equal(deriveSpecialCaseStage({ operationallyComplete: true, attention: true }), 'completed');
  assert.equal(deriveSpecialCaseStage({ closed: true, attention: true }), 'closed');
});

test('acceptance records a decision without asking for item mapping', () => {
  assert.equal(normalizeSpecialSalesDecision({ decision: 'accepted' }).decision, 'accepted');
});

const enquiry = { storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST', vendorName: 'TEST',
  fulfillmentMethod: 'mbt_delivery', deliveryAddress: 'Test address', deliveryContactName: 'Test contact', deliveryContactPhone: '555-0100',
  lines: [{ productName: 'TEST', quantity: 1, uom: 'PLT', rate: 120, requiredDate: '2099-02-01' }] };
test('enquiry captures optional existing contacts and requires only delivery address', () => {
  const options = { authorizedStoreLocationIds: [1], minimumRequiredDate: '2099-01-01' };
  const draft = normalizeSpecialCaseDraft(enquiry, options);
  assert.equal(draft.fulfillmentMethod, 'mbt_delivery');
  assert.equal(draft.deliveryContactPhone, '555-0100');
  assert.throws(() => normalizeSpecialCaseDraft({ ...enquiry, fulfillmentMethod: '' }, options));
  // The form-polish request explicitly removes mandatory delivery contacts.
  assert.equal(normalizeSpecialCaseDraft({ ...enquiry, deliveryContactPhone: '' }, options).deliveryContactPhone, '');
  assert.throws(() => normalizeSpecialCaseDraft({ ...enquiry, deliveryAddress: '' }, options));
});

const so = { customerId: 1, operationalYardLocationId: 1, fulfillmentMethod: 'vendor_pickup', palletTotal: 0,
  materialLines: [{ caseLineId: 1, itemId: 2055, quantity: 12, uom: 'PC', rate: 5, description: 'TEST A' }] };
test('SO pins product identity and enforces explicit whole pallet count', () => {
  assert.equal(normalizeSpecialSalesOrderDraft(so).palletTotal, 0);
  assert.equal(normalizeSpecialSalesOrderDraft({ ...so, palletTotal: 3, palletRate: 35 }).ancillaryLines.at(-1).itemId, 1784);
  assert.equal(normalizeSpecialSalesOrderDraft(so).ancillaryLines.length, 0);
  for (const palletTotal of [undefined, '', -1, 0.5, false, true, {}]) assert.throws(() => normalizeSpecialSalesOrderDraft({ ...so, palletTotal }));
  assert.throws(() => normalizeSpecialSalesOrderDraft({ ...so, materialLines: [{ ...so.materialLines[0], itemId: 99 }] }));
});
