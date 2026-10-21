import test from 'node:test';
import assert from 'node:assert/strict';
import { restFixture } from './special-workflow-rest-orders.test.js';
import { prepareSpecialRestAdjustmentPlan } from '../../../src/special-stock-rest-orders.js';
import { applySpecialAdjustmentPlan } from '../../../src/special-stock-adjustment-adapter.js';

test('approved SO/PO description and packing corrections survive REST writes and retry', async () => {
  const fixture = restFixture();
  for (const order of fixture.orders) Object.assign(order.lines[0], { toDescription: 'New stone Black 90mm Rough',
    fromPack: { palletQty: 0, layerQty: 0, sectionQty: 0, pieceQty: 0 }, toPack: { palletQty: 2, layerQty: 3, sectionQty: 4, pieceQty: 0 } });
  const plan = await prepareSpecialRestAdjustmentPlan({ orders: fixture.orders }, fixture);
  assert.equal(plan.orders[0].target.lines[0].description, 'New stone Black 90mm Rough');
  fixture.failPo(); await assert.rejects(applySpecialAdjustmentPlan(plan, fixture.boundary), /PO unavailable/);
  await applySpecialAdjustmentPlan(plan, fixture.boundary);
  for (const id of [11, 12]) {
    const line = fixture.records.get(id).item.items[0]; assert.equal(line.description, 'New stone Black 90mm Rough');
    assert.equal(line.custcol_plt, 2); assert.equal(line.custcol_lyr, 3); assert.equal(line.custcol_sec, 4); assert.equal(Number(line.custcol_pcs || 0), 0);
  }
  assert.equal(fixture.records.get(12).item.items[0].rate, 5);
  const count = fixture.writes.length; await applySpecialAdjustmentPlan(plan, fixture.boundary); assert.equal(fixture.writes.length, count);
});
test('remote packing drift blocks reviewed correction before the first write', async () => {
  const fixture = restFixture(); fixture.orders[0].lines[0].toPack = { palletQty: 2 };
  fixture.orders[0].lines[0].fromPack = { palletQty: 0 };
  const plan = await prepareSpecialRestAdjustmentPlan({ orders: fixture.orders }, fixture);
  fixture.records.get(12).item.items[0].custcol_plt = 99;
  await assert.rejects(applySpecialAdjustmentPlan(plan, fixture.boundary), { code: 'SPECIAL_ADJUSTMENT_CONFLICT' });
  assert.equal(fixture.writes.length, 0);
});

test('clearing reviewed SO packing writes null and retains the PO numeric-zero convention', async () => {
  const f = restFixture();
  for (const order of f.orders) {
    f.records.get(order.id).item.items[0].custcol_plt = 3;
    Object.assign(order.lines[0], { fromPack: { palletQty: 3 }, toPack: { palletQty: null } });
  }
  const plan = await prepareSpecialRestAdjustmentPlan({ orders: f.orders }, f);
  await applySpecialAdjustmentPlan(plan, f.boundary);
  assert.equal(f.records.get(11).item.items[0].custcol_plt, null);
  assert.equal(f.records.get(12).item.items[0].custcol_plt, 0);
});

test('service carries reviewed description and packing to both native order targets', async () => {
  const { createSpecialQuantityService } = await import('../../../src/special-stock-quantity-service.js');
  const f = restFixture(); let prepared;
  const detail = { id: 1, salesOrderId: 11, purchaseOrderId: 12,
    lines: [{ id: 1, productName: 'Stone', color: 'Grey', size: '80mm', detailSpec: 'Smooth' }],
    salesOrderLines: [{ ...f.orders[0].lines[0], caseLineId: 1, uom: 'PC', nativeDiscountPercent: null }],
    purchaseOrderLines: [{ ...f.orders[1].lines[0], caseLineId: 1, uom: 'PC', unitPurchaseCost: 5 }],
    quantityReview: { id: 'review', status: 'applying', adjustmentVersion: 2, lines: [{ caseLineId: 1,
      fromQuantity: 50, toQuantity: 50, fromPurchaseQuantity: 50, toPurchaseQuantity: 50, toRate: 20, toNativeDiscountPercent: 15,
      fromFields: { color: 'Grey', pieceQty: 0 }, toFields: { color: 'Black', pieceQty: 8 } }] } };
  const service = createSpecialQuantityService({ withReviewLock: async (id, run) => run(), claimReview: async () => detail,
    resolveOrderUnits: async lines => lines.map(line => ({ ...line, unitId: 865 })),
    prepareAdjustmentPlan: async input => { prepared = input; return prepareSpecialRestAdjustmentPlan(input, f); },
    applyAdjustmentPlan: plan => applySpecialAdjustmentPlan(plan, f.boundary), savePlan: async () => {},
    finishReview: async () => detail, failReview: async () => {} });
  await service.reviewQuantityChange(1, { reviewId: 'review', decision: 'approve' });
  for (const order of prepared.orders) {
    assert.equal(order.lines[0].toDescription, 'Stone Black 80mm Smooth'); assert.deepEqual(order.lines[0].toPack, { pieceQty: 8 });
    assert.equal(f.records.get(order.id).item.items[0].custcol_pcs, 8);
  }
  assert.equal(f.records.get(12).item.items[0].rate, 5);
});
