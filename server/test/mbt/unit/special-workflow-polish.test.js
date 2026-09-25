import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { normalizeSpecialFulfillment, deriveSpecialCaseStage } from '../../../src/special-stock-request-domain.js';
import * as policy from '../../../src/special-stock-request-policy.js';
import { createSpecialStockRequestService } from '../../../src/special-stock-request-service.js';

test('delivery accepts address without separate contact name or phone', () => {
  const result = normalizeSpecialFulfillment({ fulfillmentMethod: 'mbt_delivery', deliveryAddress: 'TEST delivery address' });
  assert.equal(result.deliveryAddress, 'TEST delivery address');
  assert.equal(result.deliveryContactName, '');
  assert.equal(result.deliveryContactPhone, '');
  assert.throws(() => normalizeSpecialFulfillment({ fulfillmentMethod: 'mbt_delivery' }), { code: 'SPECIAL_SO_DELIVERY_REQUIRED' });
});

test('test skip policy defaults off and accepts only the explicit gate', async () => {
  assert.equal(policy.SPECIAL_STOCK_TEST_SKIP_FLAG_KEY, 'special_stock_request_test_skip_orders');
  for (const row of [null, { enabled: false }, { enabled: 'true' }, { enabled: true, revision: 4 }]) {
    const result = await policy.getSpecialStockTestSkipPolicy({ queryFn: async (_sql, values) => {
      assert.deepEqual(values, ['special_stock_request_test_skip_orders']);
      return { rows: row ? [row] : [] };
    } });
    assert.equal(result.enabled, row?.enabled === true);
  }
});

test('property: skipped order stages match completed steps and preserve terminal/waiting priority', () => {
  fc.assert(fc.property(fc.record({
    salesOrderSkipped: fc.boolean(), purchaseOrderSkipped: fc.boolean(),
    closed: fc.boolean(), operationallyComplete: fc.boolean(), waitingForProduction: fc.boolean(),
    fulfillmentMethod: fc.constantFrom('vendor_pickup', 'yard_pickup', 'mbt_delivery')
  }), evidence => {
    const real = { ...evidence, salesOrderSkipped: false, purchaseOrderSkipped: false,
      salesOrderId: evidence.salesOrderSkipped ? 91 : null,
      purchaseOrderId: evidence.purchaseOrderSkipped ? 92 : null };
    assert.equal(deriveSpecialCaseStage(evidence), deriveSpecialCaseStage(real));
  }), { numRuns: 300, seed: 24092026 });
});

for (const step of ['salesOrderSkipped', 'purchaseOrderSkipped']) {
  for (const method of ['createSalesOrder', 'createPurchaseOrder', 'refreshSalesOrder']) {
    test(`${method} rejects ${step} before preparation or any external call`, async () => {
      const calls = [];
      const boundary = name => async () => { calls.push(name); throw new Error(`Unexpected ${name}`); };
      const service = createSpecialStockRequestService({
        getCase: async () => ({ id: 1, revision: 2, [step]: true, salesOrderId: 91 }),
        claimOperation: boundary('claim'), preparePurchaseOrder: boundary('prepare'),
        fetchSalesOrderReference: boundary('fetch'), resolveLocations: boundary('location'),
        failOperation: boundary('fail')
      });
      await assert.rejects(() => service[method](1, { lines: [], expectedRevision: 2 }), { code: 'SPECIAL_TEST_ORDER_REMOTE_BLOCKED' });
      assert.deepEqual(calls, []);
    });
  }
}
