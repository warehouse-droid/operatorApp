import { query } from '../../src/db.js';
import { persistedDispatchPlan } from '../../src/dispatch-plan-fence.js';
import { reconcileSalesOrderFamilyInDispatchPlans } from '../../src/dispatch-plan-repository.js';
import { dispatchOrder } from '../dispatch/support/dispatch-v2-fixture.js';
let sequence = 0;

export async function stored(id) {
  return persistedDispatchPlan((await query(`SELECT p.*, s.orders, s.trucks, s.summary, s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [id])).rows[0]);
}

export async function seedMaintenanceIncident(fixture, { edit = true } = {}) {
  const n = ++sequence;
  const date = `2028-03-${String(n).padStart(2, '0')}`;
  const canonicalRef = `SO-MAINT-${n}`;
  const obsolete = [`${canonicalRef}-S2`, `${canonicalRef}-S3`];
  const activeRef = `SO-MOVE-${n}`;
  const seeded = await fixture.seedPlan({ date, refs: [activeRef] });
  const sourceId = 9981000 + n;
  await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,netsuite_active)
    VALUES ($1,$2,'G','Billed',false)`, [sourceId, canonicalRef]);
  for (const [index, ref] of obsolete.entries()) {
    const id = -sourceId * 10 - index;
    await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,netsuite_active)
      VALUES ($1,$2,'G','Billed',false)`, [id, ref]);
    await query(`INSERT INTO dispatch_scm_so_splits(source_so_id,source_so_ref,split_so_id,split_so_ref)
      VALUES ($1,$2,$3,$4)`, [sourceId, canonicalRef, id, ref]);
  }
  const original = await stored(seeded.id);
  original.orders.push(...obsolete.map((ref, i) => ({ ...dispatchOrder(ref, i), originalOrderId: canonicalRef, isSplit: true })));
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1', [seeded.id, JSON.stringify(original.orders)]);
  await query('UPDATE dispatch_plans SET revision=63 WHERE id=$1', [seeded.id]);
  const baseline = await stored(seeded.id);
  const sessionId = `maintenance-${n}`;
  const token = edit ? await fixture.acquireLease({ planDate: date, sessionId }) : '';
  const cleanup = () => reconcileSalesOrderFamilyInDispatchPlans({ canonicalRef, familyRefs: obsolete, billed: true, actor: 'driver:incident-replay' });
  const save = (plan, id, classic = false) => fixture.request(classic ? `/api/dispatch/plans/${seeded.id}` : `/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: classic ? 'PUT' : 'POST', headers: { 'x-dispatch-edit-lease': token },
    body: classic ? { ...plan, planId: seeded.id, editLeaseToken: token, commandId: id, baseRevision: plan.revision, baseDigest: plan.digest, audit: { sessionId } }
      : { commandId: id, baseRevision: plan.revision, baseDigest: plan.digest, sessionId, commandType: 'replace_plan',
          payload: { planDate: date, orders: plan.orders, trucks: plan.trucks, summary: plan.summary } }
  });
  return { ...seeded, baseline, sessionId, token, obsolete, canonicalRef, cleanup, save };
}

