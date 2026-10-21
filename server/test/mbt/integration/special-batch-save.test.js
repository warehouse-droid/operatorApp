import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';

after(closeDb);
const context = { operatorId: 'special-batch-test', authorizedStoreLocationIds: [1] };
const response = (line, extra = {}) => ({ lineId: line.id, kind: 'response', supplyStatus: 'in_stock', vendorId: 8899200,
  vendorName: 'TEST Vendor', vendorYard: 'TEST yard', availabilityMode: 'no_projection', ...extra });
async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
  const transaction = await beginRollbackContext();
  try { await transaction.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST Batch Rep','hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING", [context.operatorId]);
    const detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Batch',
      vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup', lines: ['Slab','Coping','Wall'].map(productName =>
        ({ productName, quantity: 2, uom: 'PLT', rate: 10, requiredDate: '2099-02-01' })) }, context);
    await run(detail);
  }); } finally { await transaction.rollback(); }
}
const stock = (d, lines) => repo.saveSpecialStockChecks(d.id, { expectedRevision: d.revision, lines }, context);
const decisions = (d, lines, ctx = context) => repo.saveSpecialCustomerDecisions(d.id, { expectedRevision: d.revision, lines }, ctx);

test('one SCM save records all responses, and one Sales save records selected decisions', () => fixture(async initial => {
  let d = await stock(initial, initial.lines.map((line, i) => response(line, i === 1 ? { supplyStatus: 'vendor_transfer', availabilityMode: 'dated', availableDate: '2099-02-01', scmInternalNote: 'private transfer' } : { salesVisibleNote: `Reply ${i}` })));
  assert.equal(d.revision, initial.revision + 1);
  assert.deepEqual(d.lines.map(l => l.supplyStatus), ['in_stock','vendor_transfer','in_stock']);
  assert.equal(d.lines[1].availableDate, '2099-02-01');
  assert.equal(d.lines[1].scmInternalNote, 'private transfer');
  assert.equal(d.events.filter(e => e.eventType === 'special_supply_response_saved').length, 3);
  d = await decisions(d, [{ lineId: d.lines[0].id, decision: 'accepted', customerNote: 'First' }, { lineId: d.lines[1].id, decision: 'declined', reason: 'Too late' }]);
  assert.equal(d.revision, initial.revision + 2);
  assert.deepEqual(d.lines.map(l => l.salesDecision), ['accepted','declined','pending']);
  assert.equal(d.lines[0].salesCustomerNote, 'First');
  assert.equal(d.lines[1].salesDecisionReason, 'Too late');
  assert.equal(d.lines[1].scmInternalNote, undefined);
}));

test('a later invalid SCM line rolls back earlier responses, events and case revision', () => fixture(async d => {
  const before = await repo.getSpecialStockCase(d.id, { audience: 'scm' });
  await assert.rejects(stock(d, [response(d.lines[0]), response(d.lines[1], { supplyStatus: 'vendor_transfer' })]), { code: 'SPECIAL_RESPONSE_DATE_REQUIRED' });
  assert.deepEqual(await repo.getSpecialStockCase(d.id, { audience: 'scm' }), before);
}));

test('a later invalid Sales decision rolls back earlier decisions and rejects wrong scope', () => fixture(async d => {
  d = await stock(d, d.lines.map(l => response(l)));
  const before = await repo.getSpecialStockCase(d.id, { audience: 'scm' });
  await assert.rejects(decisions(d, [{ lineId: d.lines[0].id, decision: 'accepted' }, { lineId: d.lines[1].id, decision: 'declined' }]), /reason/i);
  assert.deepEqual(await repo.getSpecialStockCase(d.id, { audience: 'scm' }), before);
  await assert.rejects(decisions(d, [{ lineId: d.lines[0].id, decision: 'accepted' }], { ...context, authorizedStoreLocationIds: [9999] }), { status: 403 });
  assert.deepEqual(await repo.getSpecialStockCase(d.id, { audience: 'scm' }), before);
}));

test('batch input rejects empty, oversized, duplicate, foreign and stale writes without partial changes', () => fixture(async d => {
  for (const lines of [[], Array.from({ length: 101 }, () => response(d.lines[0])), [response(d.lines[0]), response(d.lines[0])]]) {
    await assert.rejects(stock(d, lines), { code: 'SPECIAL_BATCH_LINES_INVALID' });
  }
  await assert.rejects(stock(d, [response(d.lines[0]), response({ id: 999999999 })]), { code: 'SPECIAL_LINE_NOT_FOUND' });
  await assert.rejects(stock(d, [response(d.lines[0], { kind: 'delete' })]), { code: 'SPECIAL_BATCH_LINES_INVALID' });
  assert.equal((await repo.getSpecialStockCase(d.id)).revision, d.revision);
  const saved = await stock(d, d.lines.map(l => response(l)));
  await assert.rejects(stock(d, d.lines.map(l => response(l))), { status: 409 });
  assert.equal((await repo.getSpecialStockCase(d.id)).revision, saved.revision);
}));

test('SCM saves readiness and pending responses together while retaining transfer status', () => fixture(async d => {
  d = await stock(d, d.lines.map(l => response(l, { supplyStatus: 'vendor_transfer', availabilityMode: 'dated', availableDate: '2099-02-01' })));
  d = await decisions(d, [{ lineId: d.lines[0].id, decision: 'accepted' }]);
  const revision = d.revision;
  d = await stock(d, [{ lineId: d.lines[0].id, kind: 'readiness', ready: false, eta: '2099-03-01' }, response(d.lines[1], { salesVisibleNote: 'Second reply' })]);
  assert.equal(d.revision, revision + 1);
  assert.equal(d.lines[0].supplyStatus, 'vendor_transfer');
  assert.equal(d.lines[0].availableDate, '2099-03-01');
  assert.equal(d.lines[1].salesVisibleNote, 'Second reply');
  assert.equal(d.lines[2].availableDate, '2099-02-01');
}));
