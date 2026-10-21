import { query, withTransaction } from '../src/db.js';

// This operational repair records transport status from retained Driver proof.
// It deliberately does not authorize an accounting receipt or change source data.
export async function recoverDirectPoScheduleCompletion({ poId, poRef, driverJobRecordId }) {
  return withTransaction(async () => {
    const po = (await query(`SELECT netsuite_id FROM purchase_orders
      WHERE netsuite_id=$1 AND netsuite_active=true
        AND lower(btrim(COALESCE(NULLIF(dispatch_ref,''),tranid)))=lower(btrim($2)) FOR UPDATE`, [poId,poRef])).rows[0];
    if (!po) { throw new Error('PO identity does not match the requested status correction.'); }
    const proof = (await query(`SELECT j.id FROM driver_job_records j
      WHERE j.id=$2 AND j.status='complete' AND j.stop_type='dropoff' AND j.completed_at IS NOT NULL
        AND dispatch_po_link_transport_fully_covers($1)
        AND dispatch_linked_transport_delivery_ready('PO',$3)
        AND EXISTS (SELECT 1 FROM dispatch_so_po_allocations a JOIN purchase_order_lines l ON l.id=a.po_line_id
          WHERE a.po_order_id=$1 AND a.status='active' AND l.netsuite_active
            AND NOT dispatch_po_line_is_status_charge(l.item_id,l.sku,l.item_description,
              l.item_type,l.unit,l.pallet_qty,l.layer_qty,l.section_qty,l.piece_qty)
            AND dispatch_po_allocation_driver_job_matches(a.id,j.order_refs,j.job_details))
      FOR SHARE OF j`, [poId,driverJobRecordId,poRef])).rows[0];
    if (!proof) { throw new Error('Verified delivery proof does not cover this PO.'); }
    const before = (await query('SELECT count(*)::int AS count FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1', [poId])).rows[0].count;
    const result = (await query(`SELECT dispatch_record_order_completion('PO',$1,j.completed_at,'driver_job',j.job_id,
      j.plan_id,j.plan_date,j.load_id,'system','codex-status-repair',
      'Recovered completed split-group transport from existing Driver proof; status correction only.',
      jsonb_build_object('directPoLink',true,'poOrderId',$2::bigint,'driverJobRecordId',j.id,
        'directShipCoverageVerified',false,'directTransportCoverageVerified',true,
        'backfilled',true,'statusOnlyRecovery',true,'coverageRepair','materialized-split-reference')) AS id
      FROM driver_job_records j WHERE j.id=$3`, [poRef,poId,driverJobRecordId])).rows[0];
    const active = (await query(`SELECT completion_event_id FROM dispatch_order_completion_status
      WHERE order_kind='PO' AND lower(btrim(order_ref))=lower(btrim($1)) AND completion_event_id=$2`, [poRef,result.id])).rows[0];
    if (!active) { throw new Error('The delivery proof is superseded or does not establish current completion.'); }
    const after = (await query('SELECT count(*)::int AS count FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1', [poId])).rows[0].count;
    if (after !== before) { throw new Error('Status correction must not create receipt jobs.'); }
    return { completionEventId: active.completion_event_id, newReceiptJobs: 0 };
  });
}
