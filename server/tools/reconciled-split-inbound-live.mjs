import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../src/db.js';
import { getSmartScmProposalInventorySnapshot } from '../src/smart-scm-proposal-editor.js';
import { refreshCurrentOnOrderEvidence } from './reconciled-split-inbound-refresh.mjs';

const mode = process.argv[2] || 'read';
assert.ok(['read', 'rehearse', 'apply', 'verify'].includes(mode));
const expectedRuns = process.argv[3] ? JSON.parse(process.argv[3]) : null;
async function fingerprints(ids) {
  return (await query(`SELECT
    (SELECT md5(jsonb_agg(to_jsonb(l)-'reason'-'updated_at' ORDER BY l.id)::text)
      FROM scm_smart_proposal_lines l JOIN scm_smart_proposals p ON p.id=l.proposal_id WHERE p.run_id=ANY($1::bigint[])) AS quantities,
    (SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text) FROM scm_smart_proposals p WHERE p.run_id=ANY($1::bigint[])) AS proposals,
    (SELECT md5(jsonb_agg(jsonb_build_object('id',id,'basis',phase_two_basis) ORDER BY id)::text)
      FROM scm_smart_planning_runs WHERE id=ANY($1::bigint[])) AS approved_phase_evidence`, [ids])).rows[0];
}

try {
  const result = await withTransaction(async () => {
    await query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ ${['read', 'verify'].includes(mode) ? ', READ ONLY' : ''}`);
    const runs = (await query(`SELECT id,revision,plan_kind FROM scm_smart_planning_runs WHERE id IN
      (SELECT MAX(id) FROM scm_smart_planning_runs WHERE status='ready' GROUP BY plan_kind) ORDER BY id`)).rows;
    const current = runs.map(r => ({ id: Number(r.id), revision: Number(r.revision) }));
    if (expectedRuns) assert.deepEqual(current, expectedRuns, 'Current runs changed; review fresh evidence');
    const ids = runs.map(r => r.id);
    const before = await fingerprints(ids);
    const refreshes = [];
    for (const run of runs) refreshes.push(await refreshCurrentOnOrderEvidence(Number(run.id), {
      expectedRevision: Number(run.revision), write: ['apply', 'rehearse'].includes(mode)
    }));
    const after = await fingerprints(ids);
    assert.deepEqual(after, before, 'Operational proposal values or frozen phase evidence changed');
    if (mode === 'verify') assert.ok(refreshes.every(r => r.updates.length === 0), 'Some current evidence remains stale');
    const target = await getSmartScmProposalInventorySnapshot(5057, 28, 42);
    assert.equal(target.quantityReleasedSplitInbound, 0, 'The old received split must contribute zero');
    const saved = (await query(`SELECT l.id,l.proposed_pallets,l.reason FROM scm_smart_proposal_lines l
      JOIN scm_smart_proposals p ON p.id=l.proposal_id WHERE p.run_id=ANY($1::bigint[])
      AND l.item_id=5057 AND l.destination_location_id=28 AND p.status='held'`, [ids])).rows;
    return { mode, runs: current, refreshes, target, saved, fingerprints: after, capturedAt: new Date().toISOString() };
  }, { rollback: mode !== 'apply' });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
