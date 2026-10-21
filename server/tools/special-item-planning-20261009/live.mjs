import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeDb, query, withTransaction } from './src/db.js';
import { assertSpecialStockHandoffPlanning } from './src/dispatch-plan-repository.js';

try {
  const source = readFileSync('src/dispatch-plan-repository.js', 'utf8');
  assert.equal(source.includes('Special Item stock must be ready and require transport before planning.'), false);
  const result = await withTransaction(async () => {
    await query("SET LOCAL statement_timeout='5s'");
    const recovery = (await query(`SELECT history.id::text,history.plan_id::text,history.plan_date::text,
      history.orders,history.trucks,active.orders AS previous_orders,active.trucks AS previous_trucks
      FROM dispatch_plan_snapshot_history history JOIN dispatch_plan_snapshots active ON active.plan_id=history.plan_id
      WHERE history.id=19397`)).rows[0];
    assert.ok(recovery, 'The original failed Save draft must still be retained.');
    await assert.doesNotReject(() => assertSpecialStockHandoffPlanning(recovery, {
      previousPlan: { orders: recovery.previous_orders, trucks: recovery.previous_trucks }
    }));
    const special = (await query(`SELECT sales_order_ref,purchase_order_ref,fulfillment_method
      FROM sales_special_stock_cases WHERE request_id=125`)).rows[0];
    return { recoveryId: recovery.id, planId: recovery.plan_id, planDate: recovery.plan_date,
      originalDraftValidationPassed: true, specialCase: special, activePlanEdited: false };
  }, { rollback: true });
  const local = await fetch('http://127.0.0.1:3000/health');
  assert.equal(local.status, 200); assert.equal((await local.json()).ok, true);
  console.log(JSON.stringify({ ...result, localHealth: 200 }));
} finally {
  await closeDb();
}
