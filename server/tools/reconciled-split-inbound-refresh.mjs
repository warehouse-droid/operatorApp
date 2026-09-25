import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { query, withTransaction } from '../src/db.js';
import { writeAudit } from '../src/auth-repository.js';
import { getSmartScmProposalInventorySnapshot } from '../src/smart-scm-proposal-editor.js';

const round = value => Math.round((value + Number.EPSILON) * 1e6) / 1e6;

// Maintenance for explicitly selected current runs. Historical and issued
// proposals, frozen phase decisions, quantities and priorities remain intact.
export async function refreshCurrentOnOrderEvidence(runId, { expectedRevision, write = false } = {}) {
  return withTransaction(async () => {
    const run = (await query(`SELECT * FROM scm_smart_planning_runs WHERE id=$1 ${write ? 'FOR UPDATE' : ''}`, [runId])).rows[0];
    assert.ok(run && run.status === 'ready' && ['inventory', 'blanket'].includes(run.plan_kind), 'Select a ready planning run');
    assert.equal(Number(run.revision), expectedRevision, 'Run changed; refresh and review again');
    const lines = (await query(`SELECT l.* FROM scm_smart_proposal_lines l
      JOIN scm_smart_proposals p ON p.id=l.proposal_id WHERE p.run_id=$1
      AND p.status IN ('draft','held') AND p.superseded_at IS NULL
      AND p.netsuite_purchase_order_id IS NULL AND p.netsuite_purchase_order_ref IS NULL
      AND p.netsuite_transfer_order_id IS NULL AND p.netsuite_transfer_order_ref IS NULL
      ORDER BY l.id ${write ? 'FOR UPDATE OF p,l' : ''}`, [runId])).rows;
    const updates = [], snapshots = new Map();
    for (const line of lines) {
      const before = line.reason || {};
      assert.ok((before.destinationAllocations || []).length < 2, 'Grouped destinations need a separate evidence review');
      const key = `${line.item_id}:${line.destination_location_id}:${line.to_plt}`;
      if (!snapshots.has(key)) {
        const inventory = await getSmartScmProposalInventorySnapshot(line.item_id, line.destination_location_id, line.to_plt);
        const balance = (await query(`SELECT quantity_on_hand,synced_at FROM inventory_balances WHERE item_id=$1 AND location_id=$2`,
          [line.item_id, line.destination_location_id])).rows[0];
        snapshots.set(key, { inventory, balance });
      }
      const { inventory, balance } = snapshots.get(key);
      const toPlt = Number(line.to_plt || 0);
      const positionPallets = toPlt > 0 ? round((inventory.quantityAvailable + inventory.quantityOnOrder
        - inventory.quantityBackordered - inventory.quantityReservedOutbound) / toPlt) : 0;
      const after = { ...before, ...inventory, positionPallets,
        quantityOnHand: Number(balance?.quantity_on_hand || 0),
        inventorySyncedAt: balance?.synced_at ? new Date(balance.synced_at).toISOString() : null,
        destinationAvailablePallets: inventory.availablePallets,
        destinationExpectedAvailablePallets: inventory.expectedAvailablePallets };
      if (isDeepStrictEqual(before, after)) continue;
      const change = { lineId: Number(line.id), proposalId: Number(line.proposal_id), itemId: Number(line.item_id),
        itemName: line.item_name, proposedPallets: Number(line.proposed_pallets), before, after };
      updates.push(change);
      if (write) {
        const saved = await query(`UPDATE scm_smart_proposal_lines SET reason=$2::jsonb,updated_at=now()
          WHERE id=$1 AND reason=$3::jsonb`, [line.id, JSON.stringify(after), JSON.stringify(before)]);
        assert.equal(saved.rowCount, 1, 'Line changed; refresh aborted');
      }
    }
    const revision = expectedRevision + (write && updates.length ? 1 : 0);
    if (write && updates.length) {
      await query('UPDATE scm_smart_planning_runs SET revision=revision+1 WHERE id=$1', [runId]);
      await query(`INSERT INTO scm_smart_plan_revisions(run_id,revision,reason,before_snapshot,after_snapshot,diff)
        VALUES($1,$2,'Reconciled split on-order inventory corrected','{}','{}',$3::jsonb)`, [runId, revision, JSON.stringify({ updates })]);
      await writeAudit({ actorType: 'system', source: 'smart_scm', action: 'smart_scm.reconciled_split_inbound.inventory_refresh',
        details: { runId, revision, updates } });
    }
    return { runId, revision, written: write, updates };
  });
}
