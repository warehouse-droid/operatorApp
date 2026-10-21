import assert from 'node:assert/strict';
import test from 'node:test';
import { cargoFunctions } from '../../support/sales-order-cargo-fixture.mjs';
import { annotateFulfilledSalesOrders, fulfilledSalesDeliveryState } from '../../../src/dispatch-fulfilled-so-policy.js';

const { splitBlockReason, isDispatchPlanningRestricted } = cargoFunctions('../../public/dispatch.js',
  ['splitBlockReason', 'isDispatchPlanningRestricted'], {});

test('packing Review allows planning while packed SO and TO still require unpacking before splitting', () => {
  const row = { netsuite_id: 1, tranid: 'SO-PACKED', status: 'B', sales_order_type: 'Delivery',
    identity_count: 1, source_identity_count: 1, operator_status: 'packed', application_status: 'Reconcile Review',
    reconciliation_status: 'review', reconciliation_reason: 'Unsubmitted Operator packing on SO-PACKED.' };
  const state = fulfilledSalesDeliveryState(row);
  const [order] = annotateFulfilledSalesOrders([{ id: row.tranid, type: 'SO', operatorStatus: 'packed' }],
    new Map([['so-packed', state]]));
  assert.equal(isDispatchPlanningRestricted(order), false);
  assert.match(splitBlockReason(order), /already packed.*unpack before splitting/);
  assert.match(splitBlockReason({ ...order, type: 'TO' }), /already packed.*unpack before splitting/);
  assert.equal(order.operatorStatus, 'packed');
  assert.equal(splitBlockReason({ ...order, operatorStatus: 'open' }), '');
});

test('local loading still prevents splitting', () => {
  assert.match(splitBlockReason({ id: 'SO-LOADED', type: 'SO', localYardOrderStatus: 'Loaded' }), /cannot be split/);
});
