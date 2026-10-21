import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRegularArrival, normalizeRegularLeadHours } from '../../../public/regular-stock-input.js';
import { evaluateRegularStockApproval, planRegularStockRouting, regularReplenishmentQuantity } from '../../../src/regular-stock-domain.js';

const now = new Date('2026-09-29T14:00:00Z');
const line = (extra = {}) => ({ id: 1, itemId: 10, sourceLocationId: 1, salesQty: 200, salesUom: 'EA', decision: 'stock', ...extra });
const policy = (extra = {}) => ({ itemId: 10, sourceLocationId: 1, availableQuantity: 1000, safetyQuantity: 800, ...extra });
function evaluate(extra = {}) {
  return evaluateRegularStockApproval({ lines: [line()], policies: [policy()], arrivalAt: '2026-09-29T19:00:00Z', leadHours: 5, now, ...extra });
}
test('arrival normalizes two text fields and interprets Toronto time', () => {
  assert.deepEqual(normalizeRegularArrival('9/29/2026', '3pm'), { date: '2026-09-29', time: '15:00', arrivalAt: '2026-09-29T19:00:00.000Z', timeZone: 'America/Toronto' });
  assert.equal(normalizeRegularArrival('2026-01-15', '0830').arrivalAt, '2026-01-15T13:30:00.000Z');
});
test('invalid and ambiguous arrival input fails with a specific validation code', () => {
  for (const [date, time] of [['2026-02-30','10:00'],['','10:00'],['2026-09-29','25:00'],['2026-03-08','02:30'],['2026-11-01','01:30']]) {
    assert.throws(() => normalizeRegularArrival(date, time), error => error.code === 'REGULAR_ARRIVAL_INVALID');
  }
});
test('lead setting defaults to five and permits zero and decimal hours', () => {
  assert.equal(normalizeRegularLeadHours(undefined), 5);
  assert.equal(normalizeRegularLeadHours(0), 0);
  assert.equal(normalizeRegularLeadHours('2.5'), 2.5);
  for (const value of [-1, '', null, 'NaN', Infinity]) assert.throws(() => normalizeRegularLeadHours(value), e => e.code === 'REGULAR_LEAD_HOURS_INVALID');
});
test('safety equality approves 200 and rejects 201 with visible evidence', () => {
  assert.equal(evaluate().automatic, true);
  const result = evaluate({ lines: [line({ salesQty: 201 })] });
  assert.equal(result.automatic, false);
  assert.equal(result.lines[0].remainingQuantity, 799);
  assert.equal(result.lines[0].safetyQuantity, 800);
  assert.equal(result.lines[0].shortfallQuantity, 1);
});
test('arrival at threshold qualifies and just before requires manual review', () => {
  assert.equal(evaluate({ arrivalAt: '2026-09-29T18:59:59Z' }).automatic, false);
  assert.equal(evaluate().automatic, true);
  assert.equal(evaluate({ leadHours: 2.5, arrivalAt: '2026-09-29T16:30:00Z' }).automatic, true);
  assert.equal(evaluate({ leadHours: 0, arrivalAt: now.toISOString() }).automatic, true);
});
test('duplicate item/source demand is aggregated and missing policy never means zero safety', () => {
  const result = evaluate({ lines: [line({ salesQty: 101 }), line({ id: 2, salesQty: 100 })] });
  assert.equal(result.automatic, false);
  assert.equal(result.lines[1].remainingQuantity, 799);
  assert.equal(evaluate({ policies: [] }).automatic, false);
  assert.equal(evaluate({ policies: [policy({ safetyQuantity: null })] }).automatic, false);
});
test('one failing item sends the whole request to manual review', () => {
  assert.equal(evaluate({ lines: [line(), line({ id: 2, itemId: 11, salesQty: 1 })] }).automatic, false);
});
const so = (lines) => ({ id: 100, ref: 'SOA-100', locationId: 28, lines });
const soLine = (extra = {}) => ({ remoteLineId: 1001, itemId: 10, quantity: 200, locationId: 28, uom: 'EA', open: true, ...extra });
test('complete single-source SO changes only approved material locations', () => {
  const plan = planRegularStockRouting({ request: { destinationLocationId: 28, lines: [line()] }, salesOrder: so([soLine(), soLine({ remoteLineId: 1002, itemId: 1784, ancillary: true })]) });
  assert.equal(plan.mode, 'location');
  assert.equal(plan.sourceLocationId, 1);
  assert.deepEqual(plan.materialLineIds, [1001]);
});
test('additional local SO material makes the route a transfer', () => {
  const plan = planRegularStockRouting({ request: { destinationLocationId: 28, lines: [line()] }, salesOrder: so([soLine(), soLine({ remoteLineId: 1002, itemId: 11 })]) });
  assert.equal(plan.mode, 'transfer');
  assert.equal(plan.groups[0].sourceLocationId, 1);
  assert.equal(plan.groups[0].destinationLocationId, 28);
});
test('multiple external sources create separate routes, PO approvals also fulfill stock', () => {
  const plan = planRegularStockRouting({ request: { destinationLocationId: 28, lines: [line(), line({ id: 2, itemId: 11, sourceLocationId: 26, decision: 'po' })] }, salesOrder: so([soLine(), soLine({ remoteLineId: 1002, itemId: 11 })]) });
  assert.equal(plan.mode, 'transfer');
  assert.deepEqual(plan.groups.map(g => g.sourceLocationId), [1,26]);
});
test('SO mismatches, wrong ordering yard and closed lines cannot execute', () => {
  const request = { destinationLocationId: 28, lines: [line()] };
  for (const order of [{...so([soLine()]),locationId:1},so([soLine({quantity:199})]),so([soLine({open:false})])]) {
    assert.throws(() => planRegularStockRouting({ request, salesOrder: order }), e => e.code === 'REGULAR_SO_MISMATCH');
  }
});
test('replenishment targets preferred stock using post-commitment position once', () => {
  assert.equal(regularReplenishmentQuantity({ preferredQuantity: 1200, inventoryPositionQuantity: 899, purchaseIncrement: 1 }), 301);
  assert.equal(regularReplenishmentQuantity({ preferredQuantity: 1200, inventoryPositionQuantity: 1250, purchaseIncrement: 10 }), 0);
  assert.equal(regularReplenishmentQuantity({ preferredQuantity: 1200, inventoryPositionQuantity: 899, purchaseIncrement: 10 }), 310);
});
test('duplicate SO item rows conserve every approved quantity and retain exact line identities',()=>{
 const result=planRegularStockRouting({request:{destinationLocationId:28,lines:[line()]},salesOrder:so([soLine({quantity:150}),soLine({remoteLineId:1002,quantity:50})])});
 assert.equal(result.mode,'location');assert.deepEqual(result.materialLineIds,[1001,1002]);
 assert.deepEqual(result.mappings.map(m=>m.quantity),[150,50]);
 const ambiguous=so([soLine(),soLine({remoteLineId:1002})]);
 assert.throws(()=>planRegularStockRouting({request:{destinationLocationId:28,lines:[line()]},salesOrder:ambiguous}),e=>e.code==='REGULAR_SO_MISMATCH');
 assert.equal(planRegularStockRouting({request:{destinationLocationId:28,lines:[line()]},salesOrder:ambiguous,selectedLineIds:{10:1002}}).mode,'transfer');
});
