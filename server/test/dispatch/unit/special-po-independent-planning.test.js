import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import fc from 'fast-check';

// Exercise the production guard and reference expansion; substitute only its DB boundary.
const source = readFileSync('src/dispatch-plan-repository.js', 'utf8');
const start = source.indexOf('export async function assertSpecialStockHandoffPlanning(');
const end = source.indexOf('\nfunction collectPlanOrderRefs(', start);
assert.ok(start >= 0 && end > start);
const guardSource = source.slice(start, end).replace(/^export /, '');
const referencesSource = readFileSync('src/special-stock-planning.js', 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const references = new Function(`${referencesSource}\nreturn specialPlannedOrderRefs;`)();

function plan(...refs) {
  return {
    orders: refs.map(id => ({ id, type: id.startsWith('SO') ? 'SO' : 'PO' })),
    trucks: [{ loads: [{ stops: refs.map(orderId => ({ type: 'drop', orderId })) }] }]
  };
}

function guard(overrides = {}) {
  const row = {
    sales_order_ref: 'SOB121882', purchase_order_ref: 'POB03883',
    purchase_approved: true, close_status: 'active', fulfillment_method: 'mbt_delivery',
    quantity_review: {}, fulfillment_change: {}, waiting_for_production: false,
    attention: false, post_po_change_pending: false,
    route: null, status: 'waiting_route', purchase_status: 'B',
    purchase_status_text: 'Purchase Order : Pending Receipt', receipt_status: 'not_received',
    received_at: null, ...overrides
  };
  const query = async (_sql, [refs]) => ({ rows: refs.some(ref =>
    ['sob121882', 'pob03883', 'sn1400411'].includes(ref)) ? [row] : [] });
  return new Function('query', 'specialPlannedOrderRefs',
    `${guardSource}\nreturn assertSpecialStockHandoffPlanning;`)(query, references);
}

test('Special Request PO can be planned by dispatch reference or PO reference without an SO route', async () => {
  for (const ref of ['SN1400411', 'POB03883', 'sn1400411']) {
    await assert.doesNotReject(() => guard()(plan(ref)));
  }
});

test('notice-only handoff does not require route selection for the SO or combined plan', async () => {
  for (const refs of [['SOB121882'], ['SN1400411', 'SOB121882']]) {
    await assert.doesNotReject(() => guard()(plan(...refs)));
  }
});

test('legacy waiting-route status does not block planning', async () => {
  await assert.doesNotReject(() => guard({ route: 'direct', status: 'waiting_route' })(plan('SOB121882')));
});

test('Via Yard planning does not require a receipt for the linked PO', async () => {
  for (const status of ['ready', 'planned', 'in_progress', 'completed']) {
    const validate = guard({ route: 'via_yard', status });
    await assert.doesNotReject(() => validate(plan('SN1400411')));
    await assert.doesNotReject(() => validate(plan('SOB121882')));
    await assert.doesNotReject(() => validate(plan('SN1400411', 'SOB121882')));
  }
  for (const receipt of [
    { receipt_status: 'partial' },
    { receipt_status: 'received', received_at: '2026-10-02' }
  ]) {
    await assert.doesNotReject(() => guard({ route: 'via_yard', status: 'ready', ...receipt })(plan('SOB121882')));
  }
});

test('ready Direct sales route remains eligible', async () => {
  await assert.doesNotReject(() => guard({ route: 'direct', status: 'ready' })(plan('SOB121882')));
});

test('Special Item fulfillment method and stock readiness do not block SO or PO planning', async () => {
  for (const row of [
    { fulfillment_method: 'vendor_pickup' },
    { waiting_for_production: true },
    { fulfillment_method: 'vendor_pickup', waiting_for_production: true }
  ]) {
    for (const refs of [['SOB121882'], ['SN1400411'], ['POB03883'], ['SN1400411', 'SOB121882']]) {
      await assert.doesNotReject(() => guard(row)(plan(...refs)));
    }
  }
});

test('property: stock and fulfillment changes preserve eligible reference expansion', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom('vendor_pickup', 'yard_pickup', 'mbt_delivery'),
    fc.boolean(),
    fc.constantFrom('SOB121882', 'SN1400411', 'SN1400411-S1', 'POB03883'),
    async (fulfillment_method, waiting_for_production, ref) => {
      await assert.doesNotReject(() => guard({ fulfillment_method, waiting_for_production })(plan(ref)));
    }
  ), { seed: 20261009, numRuns: 60 });
});

test('Special request approval, closure, reviews and Attention are informational for planning', async () => {
  const cases = [
    [{ purchase_approved: false }, 'SPECIAL_PO_APPROVAL_REQUIRED'],
    [{ fulfillment_change: { status: 'applying' } }, 'SPECIAL_FULFILLMENT_PENDING'],
    [{ close_status: 'closed' }, 'SPECIAL_CLOSURE_PENDING'],
    [{ quantity_review: { status: 'pending' } }, 'SPECIAL_QUANTITY_REVIEW_REQUIRED'],
    [{ attention: true }, 'SPECIAL_PLAN_ATTENTION'],
    [{ post_po_change_pending: true }, 'SPECIAL_PLAN_ATTENTION']
  ];
  for (const [row, code] of cases) {
    const vendorWaiting = { fulfillment_method: 'vendor_pickup', waiting_for_production: true, ...row };
    await assert.doesNotReject(() => guard(vendorWaiting)(plan('SN1400411')), code);
    await assert.doesNotReject(() => guard({ route: 'via_yard', status: 'ready', ...vendorWaiting })(plan('SOB121882')), code);
  }
});

test('split PO and grouped SO references remain plannable without route selection', async () => {
  await assert.doesNotReject(() => guard()(plan('SN1400411-S1')));
  const grouped = plan('GROUP-SPECIAL');
  grouped.orders = [{ id: 'GROUP-SPECIAL', type: 'GO', childOrders: ['SOB121882'] }];
  await assert.doesNotReject(() => guard()(grouped));
  await assert.doesNotReject(() => guard({ attention: true })(grouped));
});

test('adding the PO does not revalidate an unchanged sales assignment', async () => {
  await assert.doesNotReject(() => guard()(plan('SN1400411', 'SOB121882'), {
    previousPlan: plan('SOB121882')
  }));
});


test('property: arbitrary combinations of former Special blockers never reject planning', async () => {
  await fc.assert(fc.asyncProperty(
    fc.boolean(), fc.boolean(), fc.boolean(),
    fc.constantFrom('active', 'closure_pending', 'closed'),
    fc.constantFrom('', 'pending', 'applying', 'attention', 'complete'),
    fc.constantFrom('', 'pending', 'applying', 'attention', 'complete'),
    fc.constantFrom('SOB121882', 'SN1400411', 'SN1400411-S1', 'POB03883'),
    async (purchase_approved, attention, post_po_change_pending, close_status, quantity, delivery, ref) => {
      await assert.doesNotReject(() => guard({ purchase_approved, attention, post_po_change_pending,
        close_status, quantity_review: { status: quantity }, fulfillment_change: { status: delivery } })(plan(ref)));
    }
  ), { seed: 20261012, numRuns: 100 });
});

test('Special planning does not query or lock case state', async () => {
  const failQuery = () => assert.fail('Dispatch must not consult Special request state');
  const validate = new Function('query', 'specialPlannedOrderRefs',
    `${guardSource}\nreturn assertSpecialStockHandoffPlanning;`)(failQuery, references);
  await assert.doesNotReject(() => validate(plan('SOB121882', 'POB03883')));
});
