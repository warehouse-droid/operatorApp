import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query, withTransaction, closeDb} from '../src/db.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../src/dispatch-fleet-status.js';
import {loadDispatchOrdersForResponse} from '../src/server.js';
import {sorSourceDrafts} from '../src/sor-rental-service.js';
import {getDispatchCustomOrder, dispatchOrderFromCustomOrder} from '../src/dispatch-custom-order-repository.js';
import {upsertDispatchOrderCatalog} from '../src/dispatch-order-catalog-repository.js';
import {persistedDispatchPlan} from '../src/dispatch-plan-fence.js';
import {assertDispatchExecutedPrefixPreserved} from '../src/dispatch-executed-prefix-repository.js';
import {digestDispatchPlan} from '../src/dispatch-planner-performance.js';
import {syncDispatchPlanLoadProjection} from '../src/dispatch-planner-v2-repository.js';
import {compactDispatchOrderCard, dispatchOrderSearchText} from '../src/dispatch-planner-optimization.js';

const ref = 'SOR00248-Return';
const apply = process.argv.includes('--apply');
try {
  const result = await withTransaction(async () => {
    if (!apply) await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL lock_timeout='3s'");
    await query("SET LOCAL statement_timeout='15s'");
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    const before = (await query(`SELECT * FROM dispatch_custom_orders WHERE ref_number=$1 ${apply ? 'FOR UPDATE' : ''}`, [ref])).rows[0];
    assert.equal(before?.status, 'open');
    const {drafts} = await sorSourceDrafts('SOR00248', await loadDispatchOrdersForResponse({type: 'SO', exactOrderRefs: ['SOR00248']}));
    assert.equal(drafts.length, 1);
    const draft = drafts[0];
    assert.equal(draft.refNumber, ref);
    assert.equal(draft.lineSnapshot.length, 1);
    assert.equal(Number(draft.lineSnapshot[0].itemId), 10750);
    assert.equal(Number(draft.lineSnapshot[0].quantity), 1);
    for (const [key, column] of [['pickupLocation', 'pickup_location'], ['dropoffLocation', 'dropoff_location'], ['customer', 'sor_customer']]) {
      assert.equal(draft[key], before[column], `Unexpected ${key} change`);
    }
    assert.equal(Number(draft.salesQty), Number(before.sales_qty));
    assert.equal(Number(draft.weightLbs), Number(before.weight_lbs));
    const active = await query(`SELECT id FROM driver_job_records WHERE order_refs @> jsonb_build_array($1::text)
      AND (started_at IS NOT NULL OR status IN ('in_progress','complete'))`, [ref]);
    assert.equal(active.rowCount, 0, 'Return pickup has started; do not overwrite execution');
    const plans = (await query(`SELECT DISTINCT p.id FROM dispatch_plan_order_assignments a JOIN dispatch_plans p ON p.id=a.plan_id
      WHERE a.order_ref=$1 AND p.status<>'cancelled' ORDER BY p.id`, [ref])).rows;
    assert.equal(plans.length, 1);
    const row = (await query(`SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1 ${apply ? 'FOR UPDATE OF p,s' : ''}`, [plans[0].id])).rows[0];
    const previous = persistedDispatchPlan(row);
    assert.equal(previous.orders.filter(order => order.id === ref).length, 1);
    const summary = {ref, itemId: 10750, equipment: 'S1932-7 / 7.8m', planId: previous.id, previousRevision: previous.revision};
    if (!apply) return {...summary, preview: true};
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    await query(`UPDATE dispatch_custom_orders SET line_snapshot=$2::jsonb,sor_source_fingerprint=$3,
      sor_review_reason='',updated_at=now(),updated_by='sor00248-source-repair' WHERE id=$1`,
    [before.id, JSON.stringify(draft.lineSnapshot), fingerprint]);
    const order = dispatchOrderFromCustomOrder(await getDispatchCustomOrder(before.id));
    const next = {...previous, orders: previous.orders.map(saved => saved.id === ref ? {
      ...saved, items: order.items, sorReviewReason: '', updatedAt: order.updatedAt,
      raw: {...saved.raw, line_snapshot: order.raw.line_snapshot, updated_at: order.raw.updated_at}
    } : saved)};
    await assertDispatchExecutedPrefixPreserved({previousPlan: previous, nextPlan: next});
    await query(`INSERT INTO dispatch_plan_snapshot_history
      (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id)
      VALUES($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'sor00248_source_repair','sor00248-source-repair')`,
    [previous.id, previous.planDate, previous.revision, JSON.stringify(previous.orders), JSON.stringify(previous.trucks), JSON.stringify(previous.summary), previous.savedAt]);
    next.revision = Number((await query('UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision', [previous.id])).rows[0].revision);
    await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,plan_digest=$3,saved_at=now() WHERE plan_id=$1',
      [previous.id, JSON.stringify(next.orders), digestDispatchPlan(next)]);
    await syncDispatchPlanLoadProjection(next);
    const definition = (await query('SELECT full_order FROM dispatch_global_order_splits WHERE split_ref=$1 FOR UPDATE', [ref])).rows[0];
    if (definition) {
      const refreshed = {...definition.full_order, ...order, globalOrderDefinitionKind: 'derived', isSplit: false};
      await query(`UPDATE dispatch_global_order_splits SET full_order=$2::jsonb,card=$3::jsonb,search_text=$4,updated_at=now()
        WHERE split_ref=$1`, [ref, JSON.stringify(refreshed), JSON.stringify(compactDispatchOrderCard(refreshed)), dispatchOrderSearchText(refreshed)]);
    }
    await upsertDispatchOrderCatalog({orders: [order], source: 'sor00248-source-repair'});
    await query('INSERT INTO sor_configuration_audit(actor,subject,before_state,after_state) VALUES($1,$2,$3::jsonb,$4::jsonb)',
      ['sor00248-source-repair', 'SOR00248', JSON.stringify({return: before, planRevision: previous.revision}),
        JSON.stringify({draft, planId: next.id, planRevision: next.revision, assignmentPreserved: true})]);
    return {...summary, applied: true, revision: next.revision, assignmentPreserved: true};
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
