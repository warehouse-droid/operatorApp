import assert from 'node:assert/strict';
import test from 'node:test';
import { specialStage, specialSalesOrderFulfilled } from '../../../public/special-stock-workflow.js';
import { specialCaseStageAfterEdits } from '../../../public/special-stock-case-edits.js';
import { backorderStage } from '../../../public/backorder-workflow.js';

test('resolved customer decisions without SO stay Await Customer Confirmation', () => {
  for (const waitingForProduction of [false, true]) {
    assert.equal(specialStage({ linesResolved: true, hasAcceptedLines: true, waitingForProduction }), 'await_customer_confirmation');
  }
});

test('a customer reply is still required for every open line and at least one line must be accepted', () => {
  assert.equal(specialStage({ linesResolved: false, hasAcceptedLines: true, hasPendingSalesDecision: true }), 'await_customer_confirmation');
  assert.equal(specialStage({ linesResolved: true, hasAcceptedLines: false }), 'await_customer_confirmation');
  assert.equal(specialStage({ linesResolved: false, hasAcceptedLines: true }), 'new_enquiry');
});

test('accepted ETAs remain Confirmed after order creation until the PO reference is queued', () => {
  const resolved = { linesResolved: true, hasAcceptedLines: true, salesOrderId: 11, purchaseOrderId: 12 };
  for (const fulfillmentMethod of ['vendor_pickup', 'yard_pickup', 'mbt_delivery']) {
    assert.equal(specialStage({ ...resolved, fulfillmentMethod, waitingForProduction: true }), 'confirmed');
    assert.equal(specialStage({ ...resolved, fulfillmentMethod, waitingForProduction: false }), 'confirmed');
    assert.equal(specialStage({ ...resolved, fulfillmentMethod, purchaseOrderApproved: false }), 'confirmed');
  }
});

test('closure, completion and pending information take precedence over customer confirmation', () => {
  const resolved = { linesResolved: true, hasAcceptedLines: true, waitingForProduction: true };
  assert.equal(specialStage({ ...resolved, closed: true }), 'closed');
  assert.equal(specialStage({ ...resolved, cancelled: true }), 'closed');
  assert.equal(specialStage({ ...resolved, operationallyComplete: true }), 'completed');
  assert.equal(specialStage({ ...resolved, pendingUpdate: true }), 'pending_update');
});

test('a saved edit stage cannot override complete customer confirmation', () => {
  for (const stage of ['new_enquiry', 'await_customer_confirmation', 'wait_for_production', 'pending_update']) {
    assert.equal(specialCaseStageAfterEdits({ revision: 4, lineEditState: { revision: 4, stage } }, 'confirmed'), 'confirmed');
  }
});

test('a pending edited material still requires a fresh stock check', () => {
  const stage = specialStage({ linesResolved: false, hasAcceptedLines: true });
  assert.equal(specialCaseStageAfterEdits({ revision: 4, lineEditState: { revision: 4, stage: 'new_enquiry' } }, stage), 'new_enquiry');
});

test('SO display recognizes NetSuite fulfillment even with a stale local not-fulfilled flag', () => {
  assert.equal(specialSalesOrderFulfilled({ salesOrderFulfillmentStatus: 'not_fulfilled', salesOrderStatus: 'Sales Order : Pending Billing' }), true);
  assert.equal(specialSalesOrderFulfilled({ salesOrderFulfillmentStatus: 'fulfilled', salesOrderStatus: 'Sales Order : Pending Fulfillment' }), true);
});

test('partial fulfillment and inactive NetSuite status do not display an unfulfilled SO as fulfilled', () => {
  for (const detail of [{ salesOrderFulfillmentStatus: 'partially_fulfilled' },
    { salesOrderStatus: 'Pending Billing/Partially Fulfilled' },
    { salesOrderStatus: 'Pending Billing', salesOrderActive: false }]) {
    assert.equal(specialSalesOrderFulfilled(detail), false);
  }
});

test('Backorder retains its separate order and rejection milestones', () => {
  const resolved = { linesResolved: true, hasAcceptedLines: true, waitingForProduction: true };
  assert.equal(backorderStage(resolved), 'confirmed');
  assert.equal(backorderStage({ ...resolved, purchaseOrderId: 12 }), 'confirmed');
  assert.equal(backorderStage({ ...resolved, salesOrderId: 11 }), 'confirmed');
  assert.equal(backorderStage({ linesResolved: true, hasAcceptedLines: false }), 'closed');
});
