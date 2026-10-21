// Bounded operational correction of the already-approved 15% discount.
// Run from /app with preflight, apply, or verify. Never creates an order.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const root = process.cwd();
const { query, withTransaction, closeDb } = await import(`${root}/src/db.js`);
const { getSpecialStockCase, withSpecialQuantityReviewLock } = await import(`${root}/src/special-stock-request-repository.js`);
const { createSpecialQuantityService } = await import(`${root}/src/special-stock-quantity-service.js`);
const { prepareSpecialAdjustmentPlanInNetSuite, fetchSalesOrderReferenceFromNetSuite } = await import(`${root}/src/netsuite.js`);
const { specialAdjustmentMatches } = await import(`${root}/src/special-stock-adjustment-adapter.js`);
const { createSpecialOrderDocumentService } = await import(`${root}/src/special-stock-documents.js`);
const checkpointPath = '/tmp/special-discount-SOB121380-conversion.private.json';
const description = 'Unilock Ltd Endura Coping Lineo Buff 123test';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const write = (name, value) => writeFileSync(name, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
const identity = [{ id: 1017068, kind: 'sales_order', lines: [] }, { id: 1017168, kind: 'purchase_order', lines: [] }];

async function protectedHash() {
  const { rows } = await query(`SELECT jsonb_build_object('request',to_jsonb(r),
    'case',(SELECT to_jsonb(c) FROM sales_special_stock_cases c WHERE c.request_id=r.id),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_special_stock_lines l WHERE l.request_id=r.id),
    'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM sales_special_stock_order_lines o WHERE o.request_id=r.id)) AS business
    FROM sales_stock_requests r WHERE r.request_ref='SPREQ-000006'`);
  assert.equal(rows.length, 1);
  return hash(rows[0].business);
}

function assertCase(detail, { converted = false } = {}) {
  assert.equal(detail.id, 62); assert.equal(detail.requestRef, 'SPREQ-000007');
  assert.equal(detail.salesOrderId, 1017068); assert.equal(detail.salesOrderRef, 'SOB121380');
  assert.equal(detail.purchaseOrderId, 1017168); assert.equal(detail.purchaseOrderRef, 'POB03934');
  assert.equal(detail.salesOrderApproved, true);
  assert.equal(detail.dispatchPlanning.anyPlanned, false);
  assert.equal(detail.quantityReview.status, 'approved');
  assert.equal(detail.salesOrderOperationStatus, 'linked');
  assert.equal(detail.purchaseOrderOperationStatus, 'linked');
  assert.equal(detail.attention, false);
  assert.equal(detail.salesOrderSkipped, false); assert.equal(detail.purchaseOrderSkipped, false);
  assert.equal(detail.lines.length, 1);
  const line = detail.lines[0];
  assert.deepEqual([line.id, line.packageQuantity, line.originalRate, line.discountPercent, line.conversionToPc], [10, 50, 20, 15, 1]);
  assert.deepEqual(detail.salesOrderLines.map(item => [item.itemId, item.remoteLineId, item.quantity, item.uom, item.rate, item.description]),
    [[2055, 5028178, 50, 'PC', converted ? 20 : 17, description], [1784, converted ? detail.salesOrderLines[1].remoteLineId : 5028179, 11, 'EACH', 40, 'PALLET']]);
  assert.ok(Number.isSafeInteger(detail.salesOrderLines[1].remoteLineId) && detail.salesOrderLines[1].remoteLineId > 0);
  assert.equal(detail.salesOrderLines[0].nativeDiscountPercent, converted ? 15 : undefined);
  assert.deepEqual(detail.purchaseOrderLines.map(item => [item.itemId, item.remoteLineId, item.quantity, item.uom, item.unitPurchaseCost, item.description]),
    [[2055, 5028378, 50, 'PC', 5, description]]);
  assert.deepEqual([detail.palletTotal, detail.palletRate], [11, 40]);
}

async function preflight() {
  assert.equal(existsSync(checkpointPath), false, 'Preserve the existing conversion checkpoint');
  const detail = await getSpecialStockCase(62, { audience: 'scm' });
  assertCase(detail);
  const protectedBefore = await protectedHash();
  const plan = await prepareSpecialAdjustmentPlanInNetSuite({ orders: [
    { ...identity[0], lines: [{ remoteLineId: 5028178, itemId: 2055, quantity: 50, rate: 17,
      unitId: 865, description, toQuantity: 50, toRate: 20, nativeDiscountPercent: null, toNativeDiscountPercent: 15 }] },
    identity[1]
  ] });
  assert.deepEqual(plan.orders.map(order => [order.id, order.kind]), [[1017068, 'sales_order'], [1017168, 'purchase_order']]);
  const [so, po] = plan.orders;
  assert.deepEqual(so.baseline.lines.map(line => [line.remoteLineId, line.itemId, line.quantity, line.unitId, line.rate, line.description]),
    [[5028178, 2055, 50, 865, '17', description], [5028179, 1784, 11, 246, '40', 'PALLET']]);
  assert.equal(plan.transport, 'restRecord'); assert.equal(plan.discountMode, 'amount');
  assert.deepEqual(so.target.lines.map(line => [line.itemId, line.quantity, line.rate]), [[2055, 50, '20'], [10716, null, '-150'], [1784, 11, '40']]);
  assert.deepEqual(so.target.lines[0], { ...so.baseline.lines[0], rate: '20' });
  assert.deepEqual(so.target.lines[2], { ...so.baseline.lines[1], remoteLineId: null });
  assert.deepEqual(so.target.header, so.baseline.header);
  assert.deepEqual(po.target, po.baseline);
  assert.deepEqual(po.baseline.lines.map(line => [line.remoteLineId, line.itemId, line.quantity, line.unitId, line.rate, line.description]),
    [[5028378, 2055, 50, 865, '5', description]]);
  assert.equal(50 * 20 - 150, 50 * 17);
  const reference = await fetchSalesOrderReferenceFromNetSuite(1017068);
  assert.equal(reference.tranid, 'SOB121380'); assert.equal(Number(reference.foreigntotal), 1457.7);
  assert.equal(await protectedHash(), protectedBefore);
  assert.equal((await getSpecialStockCase(62, { audience: 'scm' })).revision, detail.revision);
  write(checkpointPath, { detail, plan, reference, protectedBefore, reviewId: randomUUID(), preparedAt: new Date().toISOString() });
  console.log(JSON.stringify({ prepared: true, requestRef: detail.requestRef, salesOrderRef: detail.salesOrderRef,
    materialSubtotal: 850, palletSubtotal: 440, orderTotal: Number(reference.foreigntotal),
    targetLines: so.target.lines.map(line => [line.itemId, line.quantity, line.rate]), purchaseOrderUnchanged: true }));
}

async function seedReview(checkpoint) {
  await withTransaction(async () => {
    const locked = await query(`SELECT r.revision FROM sales_stock_requests r
      JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=62 AND r.request_ref='SPREQ-000007' FOR UPDATE OF r,c`);
    assert.equal(locked.rowCount, 1); assert.equal(Number(locked.rows[0].revision), checkpoint.detail.revision);
    const detail = await getSpecialStockCase(62, { audience: 'scm' }); assertCase(detail);
    assert.deepEqual(detail.quantityReview, checkpoint.detail.quantityReview);
    const review = { id: checkpoint.reviewId, status: 'pending', mode: 'issued', adjustmentVersion: 2,
      requestedBy: null, requestedAt: new Date().toISOString(),
      correction: 'User-requested representation of the existing approved 15% discount; commercial total unchanged.',
      previousReviewId: detail.quantityReview.id, plan: checkpoint.plan, remoteStarted: false,
      lines: [{ caseLineId: 10, productName: detail.lines[0].productName, packageUom: 'PCS',
        fromPackageQuantity: 50, toPackageQuantity: 50, fromConversion: 1, toConversion: 1,
        fromQuantity: 50, toQuantity: 50, fromPurchaseQuantity: 50, toPurchaseQuantity: 50,
        fromDiscountPercent: 15, toDiscountPercent: 15, fromRate: 17, toRate: 20,
        fromNativeDiscountPercent: null, toNativeDiscountPercent: 15, salesUom: 'PC', purchaseUom: 'PC' }] };
    await query('UPDATE sales_special_stock_cases SET quantity_review=$2::jsonb,updated_at=now() WHERE request_id=$1', [62, JSON.stringify(review)]);
    await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=62');
    await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
      VALUES(62,'special_discount_representation_requested',NULL,'all',$1::jsonb)`,
    [JSON.stringify({ reviewId: review.id, previousReviewId: review.previousReviewId, reason: review.correction,
      requestedThrough: 'User conversation', discountPercent: 15, originalRate: 20, previousNetRate: 17, materialSubtotal: 850 })]);
  });
}

async function verify(checkpoint, { preview = false } = {}) {
  const detail = await getSpecialStockCase(62, { audience: 'scm' }); assertCase(detail, { converted: true });
  assert.equal(detail.quantityReview.id, checkpoint.reviewId);
  const current = await prepareSpecialAdjustmentPlanInNetSuite({ orders: identity });
  for (const order of current.orders) {
    assert.equal(specialAdjustmentMatches(checkpoint.plan.orders.find(item => item.id === order.id).target, order.baseline), true);
  }
  assert.equal(detail.salesOrderLines[1].remoteLineId, current.orders[0].baseline.lines.find(line => line.itemId === 1784).remoteLineId);
  const reference = await fetchSalesOrderReferenceFromNetSuite(1017068);
  assert.equal(reference.tranid, checkpoint.reference.tranid);
  assert.equal(Number(reference.foreigntotal), Number(checkpoint.reference.foreigntotal), 'SO total changed');
  assert.equal(await protectedHash(), checkpoint.protectedBefore);
  const previews = [];
  if (preview) for (const audience of ['sales', 'scm']) {
    const result = await createSpecialOrderDocumentService().preview(62, 'sales_order', { audience });
    assert.equal(result.buffer.subarray(0, 5).toString(), '%PDF-');
    writeFileSync(`/tmp/SOB121380-discount-${audience}.pdf`, result.buffer, { mode: 0o600 });
    previews.push({ audience, cached: result.cached, bytes: result.buffer.length });
  }
  const result = { verified: true, requestRef: detail.requestRef, salesOrderRef: detail.salesOrderRef,
    purchaseOrderRef: detail.purchaseOrderRef, revision: detail.revision, reviewId: checkpoint.reviewId,
    materialSubtotal: 850, palletSubtotal: 440, orderTotal: Number(reference.foreigntotal),
    salesLines: current.orders[0].baseline.lines.map(line => ({ itemId: line.itemId, remoteLineId: line.remoteLineId, quantity: line.quantity, rate: line.rate })),
    purchaseOrderUnchanged: true, protectedRequestUnchanged: true, previews };
  writeFileSync('/tmp/special-discount-SOB121380-conversion-result.json', JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}

async function apply(checkpoint) {
  await withSpecialQuantityReviewLock(62, async () => {
    assert.equal(await protectedHash(), checkpoint.protectedBefore);
    let detail = await getSpecialStockCase(62, { audience: 'scm' });
    if (detail.quantityReview.id !== checkpoint.reviewId) {
      const current = await prepareSpecialAdjustmentPlanInNetSuite({ orders: identity });
      for (const order of current.orders) assert.equal(specialAdjustmentMatches(checkpoint.plan.orders.find(item => item.id === order.id).baseline, order.baseline), true);
      await seedReview(checkpoint);
      detail = await getSpecialStockCase(62, { audience: 'scm' });
    }
    const service = createSpecialQuantityService({ withReviewLock: (_id, run) => run() }); // Outer lock owns this exact case.
    await service.reviewQuantityChange(62, { decision: 'approve', reviewId: checkpoint.reviewId, expectedRevision: detail.revision }, { operatorId: null });
  });
  await verify(checkpoint, { preview: true });
}

const { withOperatorNetSuitePriority } = await import(`${root}/src/operator-netsuite-request-pool.js`);
try { await withOperatorNetSuitePriority(async () => {
  const mode = process.argv.at(-1);
  assert.ok(['preflight', 'apply', 'verify'].includes(mode), 'Choose preflight, apply, or verify');
  if (mode === 'preflight') await preflight();
  else {
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    if (mode === 'apply') await apply(checkpoint);
    else await verify(checkpoint, { preview: true });
  }
}); } finally { await closeDb(); }
process.exit(0);
