import assert from 'node:assert/strict';
import { closeDb, query, withTransaction } from './src/db.js';
import { assertSpecialStockHandoffPlanning } from './src/dispatch-plan-repository.js';
import { listFulfilledSalesDeliveryStates, assertSalesDeliveryPlanningAllowed } from './src/dispatch-fulfilled-so-repository.js';
import { loadDispatchOrdersForResponse } from './src/server.js';

const refs = ['SOB122402', 'SOB122131', 'SOB122133'];
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='15s'");
    const states = await listFulfilledSalesDeliveryStates(refs);
    await assertSalesDeliveryPlanningAllowed(refs);
    await assertSpecialStockHandoffPlanning({ orders: refs.map(id => ({ id, type: 'SO' })),
      trucks: [{ loads: [{ stops: refs.map(orderId => ({ type: 'drop', orderId })) }] }] });
    const orders = await loadDispatchOrdersForResponse({ type: 'SO', exactOrderRefs: refs });
    const facts = [];
    for (const ref of refs) {
      const state = states.get(ref.toLowerCase());
      const order = orders.find(candidate => candidate.id === ref);
      assert.ok(state && !state.blocked && !state.locallyCompleted, ref + ' is still restricted');
      assert.ok(order, ref + ' is absent from the order feed');
      assert.notEqual(order.dispatchPlanningRestricted, true, ref + ' card is restricted');
      facts.push({ ref, planningAllowed: true, packingReviewOnly: state.packingReviewOnly,
        operatorStatus: order.operatorStatus, dispatchPlanningRestricted: order.dispatchPlanningRestricted });
    }
    return { orders: facts, applicationWrites: 0, netSuiteWrites: 0, activePlanEdited: false };
  });
  const response = await fetch('http://127.0.0.1:3000/health');
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  console.log(JSON.stringify({ ...result, localHealth: 200 }));
} finally { await closeDb(); }
