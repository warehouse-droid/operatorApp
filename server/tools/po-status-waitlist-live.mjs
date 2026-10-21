// Read-only check of the three requested orders and the deployed schedule path.
import assert from 'node:assert/strict';
import { closeDb, query, withTransaction } from './src/db.js';
import { listScmSchedule } from './src/dispatch-repository.js';
import { enrichScmScheduleWithReconciliation } from './src/scm-reconciliation-repository.js';

const refs = ['LOINC-033146', 'LOINC-035332', 'PO#B03964'];
const ids = [-179615128203145, -43808732443904, 1025403];
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const rows = await listScmSchedule({ exactRefs: refs });
    const enriched = await enrichScmScheduleWithReconciliation(rows);
    const orders = rows.map(row => ({ ref: row.orderRef, status: row.calculatedStatus,
      displayedStatus: enriched.find(entry => entry.orderRef === row.orderRef)?.calculatedStatus,
      completedAt: row.dispatchCompletedAt ?? null, directShipLinked: row.directShipLinked === true }));
    const completions = (await query(`SELECT order_ref,dispatch_completed_at,
      completion_evidence_type,completion_evidence_id,
      metadata->>'directShipCoverageVerified' AS receipt_verified,
      metadata->>'directTransportCoverageVerified' AS transport_verified,
      metadata->>'coverageRepair' AS repair
      FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=ANY($1::text[])
      ORDER BY order_ref`, [refs])).rows;
    const receiptJobs = (await query('SELECT count(*)::int AS count FROM dispatch_direct_po_ir_jobs WHERE local_po_id=ANY($1::bigint[])', [ids])).rows[0].count;
    if (process.env.COMBINED_RELEASE_VERIFY === '1') {
      for (const [ref, timestamp] of [['LOINC-033146','2026-09-14T16:11:31.619Z'], ['LOINC-035332','2026-10-01T17:37:53.866Z']]) {
        const row = orders.find(entry => entry.ref === ref);
        assert.equal(row?.status, 'Completed', ref);
        assert.equal(row?.displayedStatus, 'Completed', ref);
        assert.equal(row?.completedAt, timestamp, ref);
        const proof = completions.find(entry => entry.order_ref === ref);
        assert.equal(proof?.completion_evidence_type, 'driver_job', ref);
        assert.equal(proof?.receipt_verified, 'false', ref);
        assert.equal(proof?.transport_verified, 'true', ref);
      }
      const pickup = orders.find(entry => entry.ref === 'PO#B03964');
      assert.ok(['In Transit', 'Completed'].includes(pickup?.status), 'Pickup must not remain queued or linked-only');
      assert.equal(pickup?.displayedStatus, pickup?.status);
      assert.equal(receiptJobs, 0, 'Transport-only repair must not admit an Item Receipt');
    }
    return { orders, completions, receiptJobs, readOnly: true };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
