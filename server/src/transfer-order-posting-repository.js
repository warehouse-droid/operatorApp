// @ts-check
import {isDeepStrictEqual} from 'node:util';
import {query,withTransaction} from './db.js';
import {transferPostingCompletion,transferPostingPhysicalStatus,transferVerifiedFulfillment} from './transfer-order-posting-domain.js';
import {fulfillmentTransactions} from './item-fulfillment-parts-domain.js';
import {linkedTransferDriverScope,transferPostingDate} from './transfer-order-posting-link-domain.js';

/** @param {unknown[]} orderIds @returns {Promise<Record<string,any>[]>} */
export async function readTransferDriverDependencies(orderIds) {
  return (await query(`SELECT d.id,d.transfer_order_id,d.sales_order_ref,d.dispatch_target_ref,d.dependency_mode,d.status,
      d.same_load_required,d.planned_plan_id,d.planned_load_id,d.planned_date::text,COALESCE(p.status<>'cancelled',false) AS plan_active,
      COALESCE(jsonb_agg(DISTINCT so.tranid) FILTER(WHERE so.tranid IS NOT NULL),'[]'::jsonb) AS source_order_refs
    FROM order_dependencies d LEFT JOIN dispatch_plans p ON p.id=d.planned_plan_id
    LEFT JOIN order_dependency_lines dl ON dl.dependency_id=d.id
    LEFT JOIN sales_order_lines sl ON sl.id=dl.sales_line_id LEFT JOIN sales_orders so ON so.netsuite_id=sl.sales_order_id
    WHERE d.transfer_order_id=ANY($1::bigint[]) AND d.status<>'cancelled' AND d.dependency_mode='direct_to_customer'
    GROUP BY d.id,p.status`,[orderIds])).rows;
}

/** @param {Record<string,any>} order @param {Record<string,any>[]} assignments */
function ordinaryTransferScope(order,assignments) {
  const assignment=assignments.length===1?assignments[0]:null;
  return {assignmentAmbiguous:assignments.length>1,planId:assignment?.plan_id || null,loadId:assignment?.load_id || null,
    planDate:assignment?.plan_date || transferPostingDate(order.dispatch_plan_date)};
}

/** @param {Record<string,any>} scope @param {Record<string,any>} linked */
function conflictingLinkedScope(scope,linked) {
  return scope.planId && (String(scope.planId)!==linked.planId || scope.loadId!==linked.loadId || scope.planDate!==linked.planDate);
}

/** Called inside the same transaction as the Operator record; never reads NetSuite. */
/** @param {Record<string,any>} input */
export async function captureTransferPosting({order,operatorId,recordId,transactionType,lines}) {
  const assignments=(await query(`SELECT DISTINCT a.plan_id,a.load_id,a.plan_date::text
    FROM dispatch_plan_order_assignments a JOIN dispatch_plans p ON p.id=a.plan_id AND p.status<>'cancelled'
    WHERE lower(a.order_ref)=lower($1) AND ($2::date IS NULL OR a.plan_date=$2::date)`,
  [order.tranid,order.dispatch_plan_date || null])).rows;
  const scope=ordinaryTransferScope(order,assignments);
  const linked=linkedTransferDriverScope(await readTransferDriverDependencies([order.netsuite_id]));
  const snapshot={lines,...scope,
    locationId:transactionType==='IF'?order.source_location_id || order.outbound_location_id:order.destination_location_id,
    ...(linked || {})};
  if (linked && conflictingLinkedScope(scope,linked)) {snapshot.linkError='The linked SO dispatch assignment conflicts with the saved TO plan and load.';}
  return (await query(`INSERT INTO transfer_order_posting_jobs(transaction_type,local_to_id,order_ref,operator_id,operator_record_id,snapshot)
    VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(transaction_type,operator_record_id) DO NOTHING RETURNING *`,
  [transactionType,order.netsuite_id,order.tranid,operatorId,recordId,JSON.stringify(snapshot)])).rows[0];
}

/** @param {Record<string,any>} job */
export async function readTransferCompletionEvents(job) {
  const linked=linkedTransferDriverScope(await readTransferDriverDependencies([job.local_to_id]));
  if (job.snapshot.driverTarget || linked) {
    if (!linked || linked.linkError || !isDeepStrictEqual(job.snapshot.driverTarget,linked.driverTarget)
      || String(job.snapshot.planId)!==linked.planId || job.snapshot.loadId!==linked.loadId || job.snapshot.planDate!==linked.planDate) {
      throw Object.assign(new Error('The linked SO dispatch assignment changed or was not captured. Review the saved Operator load before posting.'),
        {code:'TRANSFER_POSTING_EVIDENCE_INVALID',postingNotAttempted:true});
    }
  }
  const refs=job.snapshot.driverTarget?.orderRefs || [job.order_ref];
  return (await query(`SELECT e.*,e.plan_date::text AS plan_date,d.status AS driver_status,d.stop_type,d.completed_at
    FROM dispatch_effective_order_completion_events e
    JOIN driver_job_records d ON d.job_id=e.completion_evidence_id
      AND d.plan_id IS NOT DISTINCT FROM e.plan_id AND d.load_id=e.load_id
      AND d.plan_date IS NOT DISTINCT FROM e.plan_date AND d.order_refs ? e.order_ref
    WHERE e.order_kind=$1 AND upper(e.order_ref)=ANY($2::text[]) AND e.completion_evidence_type='driver_job'
      AND d.mbt_assignment_withdrawn_at IS NULL ORDER BY e.dispatch_completed_at DESC,e.id DESC`,
    [linked?'SO':'TO',refs.map((/** @type {unknown} */ ref)=>String(ref).toUpperCase())])).rows;
}

/** @param {Record<string,any>} job @returns {Promise<Record<string,any>[]>} */
export async function readTransferPostingEvidence(job) {
  return (await query(`SELECT job.*,
      CASE WHEN job.transaction_type='IF' THEN load.id IS NOT NULL ELSE receipt.id IS NOT NULL END AS operator_record_valid
    FROM transfer_order_posting_jobs job
    LEFT JOIN operator_load_records load ON job.transaction_type='IF' AND load.id=job.operator_record_id
      AND load.order_id=job.local_to_id AND load.order_family='transfer_order' AND load.load_type='transfer_order_load'
    LEFT JOIN receiving_receipt_records receipt ON job.transaction_type='IR' AND receipt.id=job.operator_record_id
      AND receipt.order_id=job.local_to_id AND (receipt.receipt_status IN ('partial_received','received')
        OR (receipt.receipt_status='local_direct_receipt' AND job.snapshot->'driverTarget' IS NOT NULL
          AND receipt.payload->>'reason'='direct_so_delivery'
          AND receipt.payload->>'driverJobId'=job.snapshot->>'directReceiptJobId'
          AND receipt.payload->>'planId'=job.snapshot->>'planId'
          AND receipt.payload->>'loadId'=job.snapshot->>'loadId'
          AND receipt.payload->>'planDate'=job.snapshot->>'planDate'))
    WHERE job.local_to_id=$1`,[job.local_to_id])).rows;
}

/** @param {Record<string,any>} job */
export async function readTransferPhysicalStatus(job) {
  return transferPostingPhysicalStatus(job,await readTransferPostingEvidence(job));
}

/** @param {Record<string,any>} job */
export async function readTransferFulfillmentEvidence(job) {
  return transferVerifiedFulfillment(job,await readTransferPostingEvidence(job));
}

/** @param {Record<string,any>} step */
export async function assertTransferPostingStepReady(step) {
  const job=(await query('SELECT * FROM transfer_order_posting_jobs WHERE command_id=$1',[step.commandId])).rows[0];
  if(!job){return;} // Existing non-background commands retain their original recovery contract.
  const physicalStatus=await readTransferPhysicalStatus(job);
  if(physicalStatus) {
    throw Object.assign(new Error(`The matching local load/receiving receipt or verified IF evidence is missing (${physicalStatus}).`),
      {code:'TRANSFER_POSTING_EVIDENCE_INVALID',postingNotAttempted:true});
  }
  const event=transferPostingCompletion(job,await readTransferCompletionEvents(job));
  const linkedIds=event?.linkedEvents?.map((/** @type {Record<string,any>} */ e)=>String(e.id)).sort();
  if(!event || String(event.id)!==String(job.completion_event_id)
    || (job.snapshot.driverTarget && JSON.stringify(linkedIds)!==JSON.stringify(job.snapshot.completionEventIds))) {
    throw Object.assign(new Error('The matching Driver drop-off completion is no longer effective.'),
      {code:'TRANSFER_POSTING_EVIDENCE_INVALID',postingNotAttempted:true});
  }
  return job;
}

/** @param {Record<string,any>} command */
export async function finalizeTransferPosting(command) {
  return withTransaction(async()=>{
    const job=(await query('SELECT * FROM transfer_order_posting_jobs WHERE command_id=$1 FOR UPDATE',[command.id])).rows[0];
    const evidence=command.inputSnapshot?.transferEvidence;
    if(!job || job.id!==evidence?.jobId || Number(job.operator_record_id)!==Number(evidence.operatorRecordId)
      || Number(job.completion_event_id)!==Number(evidence.completionEventId)) {throw new Error('Transfer posting completion evidence does not match its saved Operator record.');}
    if(job.status==='completed'){return job.result;}
    if(!command.steps.length || command.steps.some((/** @type {Record<string,any>} */ step)=>step.status!=='posted')) {
      throw new Error('Every transfer posting transaction must be verified before attaching evidence.');
    }
    const result={commandId:command.id,transactions:command.steps.flatMap(fulfillmentTransactions),transferEvidence:evidence};
    if(job.transaction_type==='IF') {
      await query(`UPDATE operator_load_records SET response=COALESCE(response,'{}'::jsonb)||jsonb_build_object('operatorNetSuitePosting',$2::jsonb)
        WHERE id=$1 AND order_id=$3`,[job.operator_record_id,JSON.stringify(result),job.local_to_id]);
    } else {
      const receipt=result.transactions[0];
      await query(`UPDATE receiving_receipt_records SET item_receipt_id=$2,item_receipt_tranid=$3,
        response=COALESCE(response,'{}'::jsonb)||jsonb_build_object('operatorNetSuitePosting',$4::jsonb)
        WHERE id=$1 AND order_id=$5`,[job.operator_record_id,receipt.transactionId,receipt.transactionRef,JSON.stringify(result),job.local_to_id]);
      await query('UPDATE transfer_orders SET last_item_receipt_id=$2,last_item_receipt_tranid=$3 WHERE netsuite_id=$1',
        [job.local_to_id,receipt.transactionId,receipt.transactionRef]);
    }
    await query("UPDATE transfer_order_posting_jobs SET status='completed',last_error=NULL,result=$2::jsonb,updated_at=now() WHERE id=$1",[job.id,JSON.stringify(result)]);
    return result;
  });
}

/** @param {unknown} orderId */
export async function readTransferReceiptProgress(orderId) {
  return new Map((await query(`SELECT line->>'sourceLineKey' AS key,MAX((line->>'cumulativeQuantity')::numeric) AS quantity
    FROM transfer_order_posting_jobs job CROSS JOIN LATERAL jsonb_array_elements(job.snapshot->'lines') line
    WHERE local_to_id=$1 AND transaction_type='IR' GROUP BY line->>'sourceLineKey'`,[orderId])).rows.map((/** @type {Record<string,any>} */ row)=>[row.key,Number(row.quantity)]));
}

/** @param {Record<string,any>} line @param {Map<string,number>} progress @param {boolean} [physicalOnly] */
export function applyTransferReceiptProgress(line,progress,physicalOnly=false) {
  const saved=progress.get(String(line.line_id)) || 0;
  return {...line,receiving_completed_qty:physicalOnly?saved:Math.max(Number(line.netsuite_received_qty)||0,saved)};
}

/** @param {unknown} orderId */
export async function readTransferLoadedQuantities(orderId) {
  const rows=(await query(`SELECT item_id,SUM(quantity) AS quantity FROM (
      SELECT line_id,item_id,MAX(quantity) AS quantity FROM (
        SELECT line->>'lineId' AS line_id,line->>'itemId' AS item_id,(line->>'loadedQty')::numeric AS quantity
        FROM operator_load_records load CROSS JOIN LATERAL jsonb_array_elements(load.line_snapshot) line
        WHERE load.order_id=$1 AND load.order_family='transfer_order' AND load.load_type='transfer_order_load'
        UNION ALL
        SELECT line->>'sourceLineKey',line->>'itemId',(line->>'quantity')::numeric
        FROM delivery_audit_log legacy JOIN transfer_orders t ON t.netsuite_id=legacy.order_id
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(legacy.details->'verifiedLoadLines','[]'::jsonb)) line
        WHERE legacy.order_id=$1 AND legacy.actor_type='system' AND legacy.source='admin'
          AND legacy.action='operator.to.legacy_receiving_enabled'
          AND legacy.details->>'orderRef'=t.tranid
          AND legacy.details->>'sourceNetSuiteId'=t.netsuite_id::text
      ) evidence GROUP BY line_id,item_id
    ) loaded GROUP BY item_id`,[orderId])).rows;
  return new Map(rows.map((/** @type {Record<string,any>} */ row)=>[String(row.item_id),Number(row.quantity)]));
}

/** @param {Record<string,any>[]} lines @param {Map<string,number>} loaded */
export function applyTransferLoadedQuantities(lines,loaded) {
  const remaining=new Map(loaded);
  return lines.map(line=>{
    const key=String(line.item_id),total=Number(line.quantity) || 0;
    const quantity=Math.min(total,remaining.get(key) || 0);
    remaining.set(key,Math.max(0,(remaining.get(key) || 0)-quantity));
    return {...line,transfer_order_quantity:total,
      receiving_unavailable_qty:total-quantity+(Number(line.receiving_completed_qty) || 0)};
  });
}

export async function listTransferPostingJobs() {
  const jobs=(await query(`SELECT job.id,job.local_to_id,job.transaction_type,job.order_ref,job.status,job.last_error,job.command_id,
      job.snapshot->'driverTarget' AS driver_target,job.snapshot->'lines' AS lines,job.created_at,command.status AS command_status,command.last_error AS command_error
    FROM transfer_order_posting_jobs job LEFT JOIN operator_netsuite_posting_commands command ON command.id=job.command_id
    WHERE job.status<>'completed' ORDER BY job.created_at DESC LIMIT 100`)).rows;
  const dependencies=await readTransferDriverDependencies(jobs.map((/** @type {Record<string,any>} */ job)=>job.local_to_id));
  return jobs.map((/** @type {Record<string,any>} */ job)=>{
    const target=job.driver_target || linkedTransferDriverScope(dependencies.filter((/** @type {Record<string,any>} */ d)=>String(d.transfer_order_id)===String(job.local_to_id)))?.driverTarget;
    return {...job,driver_order_refs:target?.orderRefs || [],driver_dispatch_refs:target?.dispatchRefs || []};
  });
}
