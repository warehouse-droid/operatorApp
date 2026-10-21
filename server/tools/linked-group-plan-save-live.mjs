// Execute in the app with LINKED_GROUP_READ_ONLY=1; PostgreSQL enforces it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

assert.equal(process.env.LINKED_GROUP_READ_ONLY, '1');
const runtime = name => import(pathToFileURL(resolve('src', name)).href);
const { query, withTransaction, closeDb } = await runtime('db.js');
const { assertNoActiveOrderDependenciesByRefs, normalDispatchGroupTargets,
  validateDispatchPlanDependencies } = await runtime('order-dependency-repository.js');
const { assertNoActiveConsolidationClaimsByRefs } = await runtime('delivery-consolidation-repository.js');
const { dispatchDependencyOrderRefs } = await runtime('yard-dependency-structure.js');
const source = readFileSync('src/server.js', 'utf8');
const start = source.indexOf('function dispatchOrderStructureState(');
const end = source.indexOf('\nfunction normalizeOrderType(', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({ query, normalDispatchGroupTargets,
  dispatchDependencyOrderRefs, assertNoActiveOrderDependenciesByRefs, assertNoActiveConsolidationClaimsByRefs });
vm.runInContext(source.slice(start, end).replace(/^export /gm, ''), context);

try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='25s'");
    const ref = 'GOA-9611-9612';
    const draft = (await query(`SELECT id,plan_id,plan_date::text AS plan_date,orders,trucks,summary
      FROM dispatch_plan_snapshot_history
      WHERE archive_reason='save_recovery' AND summary::text LIKE '%ORDER_DEPENDENCY_STRUCTURE_LOCK%'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(orders) o WHERE o->>'id'=$1)
      ORDER BY id DESC LIMIT 1`, [ref])).rows[0];
    assert.ok(draft, 'The affected recovery draft must exist');
    const row = (await query(`SELECT p.id,p.plan_date::text AS plan_date,p.revision,s.orders,s.trucks
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [draft.plan_id])).rows[0];
    const previous = { id: row.id, planDate: row.plan_date, orders: row.orders, trucks: row.trucks };
    const candidate = { ...previous, orders: draft.orders, trucks: draft.trucks };
    const dependencies = async () => (await query(`SELECT * FROM order_dependencies
      WHERE dispatch_target_ref=$1 ORDER BY id`, [ref])).rows;
    const before = await dependencies();
    const lineState = async () => (await query(`SELECT l.* FROM order_dependency_lines l
      JOIN order_dependencies d ON d.id=l.dependency_id WHERE d.dispatch_target_ref=$1 ORDER BY l.id`, [ref])).rows;
    const beforeLines = await lineState();
    const active = before.find(d => d.status === 'active' && d.transfer_order_ref === 'TOB01180');
    assert.ok(active);
    assert.equal(active.dependency_mode, 'direct_to_customer');
    let structureError = null;
    try { await context.assertNoConsolidationStructureConflict(previous, candidate); }
    catch (error) { structureError = { code: error.code, message: error.message }; }
    const timingConflicts = await validateDispatchPlanDependencies(candidate);
    const groupConflicts = timingConflicts.filter(message => message.includes(ref) || message.includes('TOB01180'));
    const expectedFixed = process.env.LINKED_GROUP_EXPECT_FIXED === '1';
    if (structureError && expectedFixed) {
      const comparison = await context.dispatchOrderStructureComparisonPlan(previous, candidate);
      const comparisonGroup = comparison.orders.find(order => order.id === ref);
      console.error(JSON.stringify({ changedRefs: context.changedDispatchOrderStructureRefs(comparison, candidate),
        comparisonMembers: comparisonGroup?.childOrders,
        draftMembers: candidate.orders.find(order => order.id === ref)?.childOrders,
        previousGroupPresent: previous.orders.some(order => order.id === ref),
        beforeMembership: context.dispatchOrderStructureState(comparison).membership.get('SOA09611'),
        afterMembership: context.dispatchOrderStructureState(candidate).membership.get('SOA09611') }));
    }
    if (expectedFixed) {
      assert.equal(structureError, null);
      assert.deepEqual(groupConflicts, []);
    } else {
      assert.equal(structureError?.code, 'ORDER_DEPENDENCY_STRUCTURE_LOCK');
    }
    assert.deepEqual(await dependencies(), before);
    assert.deepEqual(await lineState(), beforeLines);
    const after = (await query('SELECT revision FROM dispatch_plans WHERE id=$1', [row.id])).rows[0];
    assert.equal(after.revision, row.revision);
    return { passed: true, readOnly: true, expectedFixed, order: ref, transfer: active.transfer_order_ref,
      mode: active.dependency_mode, planId: String(row.id), planDate: row.plan_date,
      recoverySnapshotId: String(draft.id), structureError, groupTimingConflicts: groupConflicts,
      otherTimingConflicts: timingConflicts.filter(message => !groupConflicts.includes(message)),
      unchangedRevision: String(row.revision), unchangedAllocations: true,
      sourceHash: createHash('sha256').update(source).digest('hex') };
  }, { rollback: true });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
