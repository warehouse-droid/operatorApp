import {query,closeDb} from "../src/db.js";

// Reuse the deployed coverage/readiness rules and immutable Driver proof.
// This only rebuilds canonical completion evidence; it never replays a Driver job.
const candidates=`WITH linked AS (
  SELECT DISTINCT po.netsuite_id,po.tranid,po.dispatch_ref,
    btrim(COALESCE(NULLIF(po.dispatch_ref,''),po.tranid)) AS order_ref
  FROM purchase_orders po JOIN dispatch_so_po_allocations allocation ON allocation.po_order_id=po.netsuite_id
  WHERE allocation.status='active'
), candidates AS MATERIALIZED (
  SELECT linked.netsuite_id AS po_order_id,linked.order_ref,evidence.id AS driver_record_id,
    evidence.job_id,evidence.completed_at,evidence.plan_id,evidence.plan_date,evidence.load_id,evidence.driver_login
  FROM linked CROSS JOIN LATERAL (
    SELECT job.* FROM driver_job_records job
    WHERE job.status='complete' AND job.stop_type='dropoff' AND job.completed_at IS NOT NULL
      AND (job.order_refs ?| ARRAY[linked.tranid,linked.dispatch_ref] OR EXISTS (
        SELECT 1 FROM dispatch_so_po_allocations allocation WHERE allocation.po_order_id=linked.netsuite_id
          AND allocation.status='active' AND job.order_refs ?| ARRAY[allocation.sales_order_ref,allocation.dispatch_target_ref]))
    ORDER BY job.completed_at DESC,job.id DESC LIMIT 1
  ) evidence
  WHERE dispatch_linked_transport_delivery_ready('PO',linked.order_ref)
    AND NOT EXISTS(SELECT 1 FROM dispatch_order_completion_events event WHERE event.order_kind='PO'
      AND lower(btrim(event.order_ref))=lower(linked.order_ref) AND event.completion_evidence_type='driver_job'
      AND event.completion_evidence_id=evidence.job_id)
)
`;

export async function recoverDirectShipCompletions({apply=false}={}) {
  const projection=apply?`,dispatch_record_order_completion('PO',order_ref,completed_at,'driver_job',job_id,
    plan_id,plan_date,load_id,'driver',COALESCE(driver_login,''),'',jsonb_build_object(
      'directPoLink',true,'poOrderId',po_order_id,'driverJobRecordId',driver_record_id,'directShipCoverageVerified',true)) AS completion_event_id`:"";
  return (await query(candidates+`SELECT candidates.*${projection} FROM candidates ORDER BY order_ref`)).rows;
}

if (process.argv[1]?.endsWith("/direct-ship-recover.mjs")) {
  try {process.stdout.write(JSON.stringify(await recoverDirectShipCompletions({apply:process.argv.includes("--apply")}))+"\n");}
  finally {await closeDb();}
}
