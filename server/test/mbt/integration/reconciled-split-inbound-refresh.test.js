import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query } from '../../../src/db.js';
import { isolated, fixture, phaseRun, itemId, itemName } from '../../support/split-inbound-completion-fixture.mjs';
import { refreshCurrentOnOrderEvidence } from '../../../tools/reconciled-split-inbound-refresh.mjs';

after(closeDb);
async function seed() {
  await fixture();
  const runId = await phaseRun();
  const proposal = (await query(`INSERT INTO scm_smart_proposals(run_id,proposal_key,proposal_type,phase,
    source_kind,destination_location_id,destination_name,status,proposal_origin,total_pallets)
    VALUES($1,'on-order-refresh','PO','direct_vendor','vendor',1,'3445','held','inventory',2) RETURNING *`, [runId])).rows[0];
  const line = (await query(`INSERT INTO scm_smart_proposal_lines(proposal_id,item_id,item_name,destination_location_id,
    destination_name,to_plt,proposed_pallets,sales_quantity,reason)
    VALUES($1,$2,$3,1,'3445',102.3,2,204.6,'{"quantityOnOrder":546,"quantityReleasedSplitInbound":546,"manuallyAdjusted":true}') RETURNING *`,
  [proposal.id, itemId, itemName])).rows[0];
  return { runId, proposal, line };
}

test('inventory evidence refresh is a preview then audited idempotent update preserving edited lines', () => isolated(async () => {
  const { runId, proposal, line } = await seed();
  const preview = await refreshCurrentOnOrderEvidence(runId, { expectedRevision: 1 });
  assert.equal(preview.updates.length, 1);
  assert.deepEqual((await query('SELECT * FROM scm_smart_proposal_lines WHERE id=$1', [line.id])).rows[0], line);
  const applied = await refreshCurrentOnOrderEvidence(runId, { expectedRevision: 1, write: true });
  assert.equal(applied.revision, 2);
  const actual = (await query('SELECT * FROM scm_smart_proposal_lines WHERE id=$1', [line.id])).rows[0];
  assert.deepEqual({ ...actual, reason: line.reason, updated_at: line.updated_at }, line);
  assert.equal(actual.reason.quantityOnOrder, 0);
  assert.equal(actual.reason.manuallyAdjusted, true);
  assert.deepEqual((await query('SELECT * FROM scm_smart_proposals WHERE id=$1', [proposal.id])).rows[0], proposal);
  assert.deepEqual((await refreshCurrentOnOrderEvidence(runId, { expectedRevision: 2, write: true })).updates, []);
  const audit = (await query(`SELECT details FROM delivery_audit_log WHERE action='smart_scm.reconciled_split_inbound.inventory_refresh'
    AND details->>'runId'=$1`, [String(runId)])).rows;
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].details.updates[0].before, line.reason);
  assert.deepEqual(audit[0].details.updates[0].after, actual.reason);
}));

test('revision mismatch aborts all evidence changes', () => isolated(async () => {
  const { runId, line } = await seed();
  await assert.rejects(() => refreshCurrentOnOrderEvidence(runId, { expectedRevision: 8, write: true }), /Run changed/);
  assert.deepEqual((await query('SELECT * FROM scm_smart_proposal_lines WHERE id=$1', [line.id])).rows[0], line);
}));

test('blanket evidence can refresh while completed proposals and approved phase basis stay immutable', () => isolated(async () => {
  const { runId, proposal, line } = await seed();
  await query(`UPDATE scm_smart_planning_runs SET plan_kind='blanket',phase_two_basis='{"immutable":true}' WHERE id=$1`, [runId]);
  assert.equal((await refreshCurrentOnOrderEvidence(runId, { expectedRevision: 1, write: true })).updates.length, 1);
  assert.deepEqual((await query('SELECT phase_two_basis FROM scm_smart_planning_runs WHERE id=$1', [runId])).rows[0].phase_two_basis, { immutable: true });
  await query(`UPDATE scm_smart_proposals SET status='completed' WHERE id=$1`, [proposal.id]);
  await query('UPDATE scm_smart_proposal_lines SET reason=$2 WHERE id=$1', [line.id, line.reason]);
  assert.deepEqual((await refreshCurrentOnOrderEvidence(runId, { expectedRevision: 2, write: true })).updates, []);
  assert.deepEqual((await query('SELECT reason FROM scm_smart_proposal_lines WHERE id=$1', [line.id])).rows[0].reason, line.reason);
}));
