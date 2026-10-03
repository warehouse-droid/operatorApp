import { query } from "./db.js";

const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? "").trim();

export function movementDocuments(response = {}, additional = [], sourceOrderId = null) {
  const documents = new Map();
  const transactions = list(response?.operatorNetSuitePosting?.transactions).filter((entry) => (
    !(Number(sourceOrderId) > 0 && Number(entry?.sourceNetSuiteId) > 0)
      || text(entry.sourceNetSuiteId) === text(sourceOrderId)
  ));
  for (const entry of [...transactions, ...list(additional)]) {
    const type = text(entry?.transactionType).toUpperCase();
    const ref = text(entry?.transactionRef);
    if (["IR", "IF"].includes(type) && ref) documents.set(`${type}:${ref}`, { type, ref });
  }
  return [...documents.values()];
}

// Only call with record IDs already selected through the caller's operator/yard
// scope. These are local read-only lookups; no NetSuite requests are made.
export async function movementRecordEvidence({ loadIds = [], receiptIds = [], coReceiptIds = [], driverIds = [] } = {}) {
  if (![loadIds, receiptIds, coReceiptIds, driverIds].some((ids) => ids.length)) return new Map();
  const result = await query(
    `WITH loads AS (
       SELECT l.id, l.load_type, l.order_family, l.order_id, l.created_at,
              jsonb_build_object('operatorNetSuitePosting', jsonb_build_object('transactions',
                l.response->'operatorNetSuitePosting'->'transactions')) AS response,
              COALESCE(NULLIF(l.order_ref, ''), so.tranid, tr.tranid, co.co_ref) AS reference,
              COALESCE(so.local_yard_order_status, tr.local_yard_order_status, co.status, '') AS current_status
         FROM operator_load_records l
         LEFT JOIN sales_orders so ON l.order_family='sales_order' AND so.netsuite_id=l.order_id
         LEFT JOIN transfer_orders tr ON l.order_family='transfer_order' AND tr.netsuite_id=l.order_id
         LEFT JOIN local_co_orders co ON l.source_table='local_co_orders' AND co.id=l.source_record_id
        WHERE l.id=ANY($1::bigint[])
     ), completions AS (
       SELECT l.id AS load_record_id, event.id
         FROM loads l
         JOIN dispatch_effective_order_completion_events event
           ON event.order_kind=CASE l.order_family WHEN 'sales_order' THEN 'SO'
                WHEN 'transfer_order' THEN 'TO' WHEN 'vrma_order' THEN 'VRMA' END
          AND lower(btrim(event.order_ref))=lower(btrim(l.reference))
          AND event.dispatch_completed_at >= l.created_at
          AND event.completion_evidence_type IN ('driver_job','manual_dispatch','direct_dependency','vrma_completion')
     ), candidate_documents AS (
       SELECT c.id, c.completion_event_id, c.line_snapshot,
              jsonb_build_object('transactionType','IF','transactionRef',c.netsuite_transaction_ref) AS document
         FROM dispatch_sales_order_if_candidates c
        WHERE c.netsuite_transaction_ref IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM netsuite_item_fulfillment_parts p
                           WHERE p.plan_external_id=c.external_id AND p.status='posted')
          AND c.completion_event_id IN (
            SELECT id FROM completions
            UNION ALL
            SELECT e.id FROM driver_job_records d
              JOIN dispatch_effective_order_completion_events e
                ON e.completion_evidence_type='driver_job' AND e.completion_evidence_id=d.job_id
             WHERE d.id=ANY($4::bigint[])
          )
       UNION ALL
       SELECT c.id, c.completion_event_id, c.line_snapshot,
              jsonb_build_object('transactionType','IF','transactionRef',p.netsuite_transaction_ref)
         FROM dispatch_sales_order_if_candidates c
         JOIN netsuite_item_fulfillment_parts p ON p.plan_external_id=c.external_id AND p.status='posted'
        WHERE c.completion_event_id IN (
            SELECT id FROM completions
            UNION ALL
            SELECT e.id FROM driver_job_records d
              JOIN dispatch_effective_order_completion_events e
                ON e.completion_evidence_type='driver_job' AND e.completion_evidence_id=d.job_id
             WHERE d.id=ANY($4::bigint[])
          )
     )
     SELECT 'load-' || l.id AS key, l.reference AS order_ref, l.response,
            COALESCE((SELECT jsonb_agg(c.document) FROM candidate_documents c
              JOIN completions e ON e.id=c.completion_event_id AND e.load_record_id=l.id
              WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(c.line_snapshot) line
                             WHERE line->>'operatorLoadRecordId'=l.id::text)), '[]'::jsonb) AS documents,
            l.load_type IN ('sales_order_delivery_load','transfer_order_load','local_co_load','vrma_local_load')
              AND lower(l.current_status) NOT IN ('closed','cancelled','canceled')
              AND NOT EXISTS (SELECT 1 FROM completions e WHERE e.load_record_id=l.id)
              AND NOT EXISTS (SELECT 1 FROM driver_job_records d
                    WHERE l.order_family='co_order' AND d.status='complete' AND d.stop_type='dropoff'
                      AND d.completed_at >= l.created_at AND d.order_refs @> jsonb_build_array(l.reference))
              AS waiting_for_driver_completion, l.order_id AS source_order_id
       FROM loads l
     UNION ALL
     SELECT 'receipt-' || r.id, NULL, r.response,
            jsonb_build_array(jsonb_build_object('transactionType','IR','transactionRef',r.item_receipt_tranid)), false, r.order_id
       FROM receiving_receipt_records r WHERE r.id=ANY($2::bigint[])
     UNION ALL
     SELECT 'co-receipt-' || r.id, NULL, r.response, '[]'::jsonb, false, NULL::bigint
       FROM local_co_receipt_records r WHERE r.id=ANY($3::bigint[])
     UNION ALL
     SELECT 'driver-' || d.id, e.order_ref, '{}'::jsonb,
            COALESCE(jsonb_agg(c.document) FILTER (WHERE c.document IS NOT NULL),'[]'::jsonb), false, NULL::bigint
       FROM driver_job_records d
       JOIN dispatch_effective_order_completion_events e
         ON e.completion_evidence_type='driver_job' AND e.completion_evidence_id=d.job_id
       LEFT JOIN candidate_documents c ON c.completion_event_id=e.id
      WHERE d.id=ANY($4::bigint[])
      GROUP BY d.id, e.order_ref`,
    [loadIds, receiptIds, coReceiptIds, driverIds]
  );
  const evidence = new Map();
  for (const row of result.rows) {
    const key = row.key.startsWith("driver-") ? `${row.key}:${text(row.order_ref).toLowerCase()}` : row.key;
    evidence.set(key, {
      documents: movementDocuments(row.response, row.documents, row.source_order_id),
      waitingForDriverCompletion: row.waiting_for_driver_completion === true
    });
  }
  return evidence;
}

export async function enrichYardMovementEvidence(rows) {
  const ids = { loadIds: [], receiptIds: [], coReceiptIds: [], driverIds: [] };
  const keysFor = (row) => list(row.record_keys).map((key) => {
    const [source, direction, type, id] = key.split(":");
    if (source === "driver") return { key: `driver-${direction}:${text(row.tranid).toLowerCase()}`, group: "driverIds", id: direction };
    if (direction === "outbound") return { key: `load-${id}`, group: "loadIds", id };
    if (type === "co_order") return { key: `co-receipt-${id}`, group: "coReceiptIds", id };
    return { key: `receipt-${id}`, group: "receiptIds", id };
  });
  for (const row of rows) for (const record of keysFor(row)) ids[record.group].push(record.id);
  for (const group of Object.keys(ids)) ids[group] = [...new Set(ids[group])];
  const evidence = await movementRecordEvidence(ids);
  return rows.map(({ record_keys, ...row }) => {
    const records = keysFor({ ...row, record_keys }).map(({ key }) => evidence.get(key)).filter(Boolean);
    return {
      ...row,
      documents: movementDocuments({}, records.flatMap((record) => record.documents.map(({ type, ref }) => ({ transactionType: type, transactionRef: ref })))),
      waitingForDriverCompletion: records.some((record) => record.waitingForDriverCompletion)
    };
  });
}
