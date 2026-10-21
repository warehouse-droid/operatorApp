import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { specialItemDescription } from '../../../public/special-stock-line-details.js';

after(closeDb);
const context = { operatorId: 'special-item-name-test', authorizedStoreLocationIds: [1] };
const response = (line, extra = {}) => ({ lineId: line.id, kind: 'response', supplyStatus: 'in_stock',
  availabilityMode: 'no_projection', vendorId: 330, vendorName: 'BWS', vendorYard: 'Vendor yard', ...extra });
const stock = (detail, lines) => repo.saveSpecialStockChecks(detail.id, { expectedRevision: detail.revision, lines }, context);
async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const transaction = await beginRollbackContext();
  try { await transaction.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST SCM','hash','salt','scm',ARRAY['scm'],ARRAY[1]) ON CONFLICT DO NOTHING", [context.operatorId]);
    const detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Item Name',
      vendorId: 330, vendorName: 'best wat', fulfillmentMethod: 'yard_pickup',
      lines: ['Fire Pit 32" Square Insret', 'Coping'].map(productName => ({ productName, quantity: 2, uom: 'PLT',
        rate: 100, discountPercent: 5, color: 'Grey', size: '32 in', detailSpec: 'TEST spec', requiredDate: '2099-02-01' })) }, context);
    await run(detail);
  }); } finally { await transaction.rollback(); }
}

test('SCM vendor and item-name correction persists while awaiting customer confirmation with an audit', () => fixture(async detail => {
  detail = await stock(detail, detail.lines.map(line => response(line)));
  assert.equal(detail.stage, 'await_customer_confirmation');
  const before = detail;
  detail = await stock(detail, [response(detail.lines[0], { productName: ' Fire Pit 32" Square Insert ' })]);
  assert.equal(detail.revision, before.revision + 1);
  assert.equal(detail.vendorName, 'BWS');
  assert.equal(detail.lines[0].brand, 'BWS');
  assert.equal(detail.lines[0].productName, 'Fire Pit 32" Square Insert');
  assert.equal(detail.lines[1].productName, 'Coping');
  assert.match(specialItemDescription(detail.lines[0]), /^BWS · Fire Pit 32" Square Insert · Grey · 32 in · TEST spec$/);
  for (const key of ['quantity', 'uom', 'originalRate', 'discountPercent', 'color', 'size', 'detailSpec', 'salesDecision', 'palletQty']) {
    assert.equal(detail.lines[0][key], before.lines[0][key], key);
  }
  const correction = detail.events.find(event => event.eventType === 'special_item_name_corrected');
  assert.equal(correction.details.previousProductName, 'Fire Pit 32" Square Insret');
  assert.equal(correction.details.productName, 'Fire Pit 32" Square Insert');
  assert.equal(correction.actorId, context.operatorId);
}));

test('a vendor spelling correction updates each line brand while omitted item names remain unchanged', () => fixture(async detail => {
  const names = detail.lines.map(line => line.productName);
  detail = await stock(detail, detail.lines.map(line => response(line)));
  assert.equal(detail.vendorName, 'BWS');
  assert.deepEqual(detail.lines.map(line => line.brand), ['BWS', 'BWS']);
  assert.deepEqual(detail.lines.map(line => line.productName), names);
  assert.equal(detail.events.filter(event => event.eventType === 'special_item_name_corrected').length, 2);
}));

test('invalid, foreign, mixed-vendor and stale stock saves leave all item names and revisions unchanged', () => fixture(async detail => {
  const before = await repo.getSpecialStockCase(detail.id, { audience: 'scm' });
  const first = response(detail.lines[0], { productName: 'Corrected first item' });
  for (const second of [response(detail.lines[1], { productName: '' }), response({ id: 999999999 }),
    response(detail.lines[1], { vendorId: 999, vendorName: 'Other Vendor' })]) {
    await assert.rejects(stock(detail, [first, second]));
    assert.deepEqual(await repo.getSpecialStockCase(detail.id, { audience: 'scm' }), before);
  }
  const saved = await stock(detail, [first]);
  await assert.rejects(stock(detail, [response(detail.lines[0], { productName: 'Stale overwrite' })]), { status: 409 });
  assert.deepEqual(await repo.getSpecialStockCase(detail.id, { audience: 'scm' }), saved);
}));

test('a linked or skipped SO keeps the existing stock-response edit lock', () => fixture(async detail => {
  await query('UPDATE sales_special_stock_cases SET sales_order_skipped=true WHERE request_id=$1', [detail.id]);
  const before = await repo.getSpecialStockCase(detail.id, { audience: 'scm' });
  await assert.rejects(stock(detail, [response(detail.lines[0], { productName: 'Changed after SO' })]), { code: 'SPECIAL_RESPONSE_USE_REVIEW' });
  assert.deepEqual(await repo.getSpecialStockCase(detail.id, { audience: 'scm' }), before);
}));
