import { query } from "./db.js";
import { writeAudit } from "./auth-repository.js";

const HISTORY_ACTIONS = ["delivery.line.confirm", "receiving.line.confirm"];

function cleanLimit(limit) {
  return Math.min(Math.max(Number(limit) || 100, 1), 200);
}

function dateClause(alias, date, params) {
  if (!date) return "";
  params.push(String(date).slice(0, 10));
  return ` AND ${alias}.created_at::date = $${params.length}::date`;
}

function normalizeRecord(row) {
  return {
    id: row.id,
    type: row.type,
    action: row.action,
    title: row.title,
    orderId: row.order_id || null,
    tranid: row.tranid || "",
    reference: row.reference || "",
    status: row.status || "",
    createdAt: row.created_at,
    details: row.details || {},
    photos: Array.isArray(row.photos) ? row.photos : []
  };
}

export async function listOperatorHistory({ operatorId, date = "", limit = 100 } = {}) {
  const safeLimit = cleanLimit(limit);
  const records = [];

  const auditParams = [operatorId, HISTORY_ACTIONS];
  const auditDate = dateClause("a", date, auditParams);
  const audit = await query(
    `SELECT ('audit-' || a.id) AS id,
            CASE WHEN a.source = 'receiving' THEN 'confirm_line' ELSE 'confirm_line' END AS type,
            a.action,
            CASE WHEN a.action = 'receiving.line.confirm' THEN 'Receiving confirm line' ELSE 'Delivery confirm line' END AS title,
            a.order_id,
            COALESCE(dord.tranid, ro.tranid, a.details->>'receivingOrderId', a.details->>'orderId', a.order_id::text) AS tranid,
            COALESCE(a.details->>'itemName', a.details->>'sku', a.line_id::text, '') AS reference,
            'confirmed' AS status,
            a.created_at,
            jsonb_build_object(
              'source', a.source,
              'lineId', a.line_id,
              'auditId', a.id,
              'auditDetails', a.details,
              'lines', jsonb_build_array(
                CASE
                  WHEN a.action = 'delivery.line.confirm' THEN jsonb_build_object(
                    'itemName', dl.item_name,
                    'description', dl.item_description,
                    'pallets', a.details->>'pallets',
                    'layers', a.details->>'layers',
                    'sections', a.details->>'sections',
                    'pieces', a.details->>'pieces',
                    'salesQuantity', COALESCE(
                      (NULLIF(a.details->>'pallets', '')::numeric * COALESCE(dl.to_plt, 0)) +
                      (NULLIF(a.details->>'layers', '')::numeric * COALESCE(dl.to_lyr, 0)) +
                      (NULLIF(a.details->>'sections', '')::numeric * COALESCE(dl.to_sec, 0)) +
                      (NULLIF(a.details->>'pieces', '')::numeric * COALESCE(dl.to_pcs, 1)),
                      NULLIF(a.details->>'pieces', '')::numeric,
                      NULLIF(a.details->>'sections', '')::numeric,
                      NULLIF(a.details->>'layers', '')::numeric,
                      NULLIF(a.details->>'pallets', '')::numeric
                    )
                  )
                  ELSE jsonb_build_object(
                    'itemName', rl.item_name,
                    'description', rl.item_description,
                    'pallets', a.details->>'pallets',
                    'layers', a.details->>'layers',
                    'sections', a.details->>'sections',
                    'pieces', a.details->>'pieces',
                    'salesQuantity', COALESCE(
                      (NULLIF(a.details->>'pallets', '')::numeric * COALESCE(rl.to_plt, 0)) +
                      (NULLIF(a.details->>'layers', '')::numeric * COALESCE(rl.to_lyr, 0)) +
                      (NULLIF(a.details->>'sections', '')::numeric * COALESCE(rl.to_sec, 0)) +
                      (NULLIF(a.details->>'pieces', '')::numeric * COALESCE(rl.to_pcs, 1)),
                      NULLIF(a.details->>'pieces', '')::numeric,
                      NULLIF(a.details->>'sections', '')::numeric,
                      NULLIF(a.details->>'layers', '')::numeric,
                      NULLIF(a.details->>'pallets', '')::numeric
                    )
                  )
                END
              )
            ) AS details,
            '[]'::jsonb AS photos
     FROM delivery_audit_log a
     LEFT JOIN delivery_orders dord ON dord.netsuite_id = a.order_id
     LEFT JOIN receiving_orders ro ON ro.netsuite_id = NULLIF(a.details->>'receivingOrderId', '')::bigint
     LEFT JOIN delivery_order_lines dl ON dl.id = a.line_id AND a.action = 'delivery.line.confirm'
     LEFT JOIN receiving_order_lines rl ON rl.order_id = ro.netsuite_id AND rl.line_id = a.line_id AND a.action = 'receiving.line.confirm'
     WHERE a.actor_operator_id = $1
       AND a.action = ANY($2::text[])
       ${auditDate}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ${safeLimit}`,
    auditParams
  );
  records.push(...audit.rows.map(normalizeRecord));

  const fulfillmentParams = [operatorId];
  const fulfillmentDate = dateClause("f", date, fulfillmentParams);
  const fulfillments = await query(
    `SELECT ('fulfillment-' || f.id) AS id,
            'item_fulfillment' AS type,
            'delivery.order.fulfill' AS action,
            'Item Fulfillment' AS title,
            f.order_id,
            o.tranid,
            COALESCE(f.item_fulfillment_tranid, f.item_fulfillment_id::text, '') AS reference,
            f.fulfillment_status AS status,
            f.created_at,
            jsonb_build_object(
              'recordId', f.id,
              'itemFulfillmentId', f.item_fulfillment_id,
              'itemFulfillmentTranid', f.item_fulfillment_tranid,
              'orderType', o.order_type,
              'lines', COALESCE(fulfilled_lines.lines, '[]'::jsonb),
              'payload', f.payload,
              'response', f.response
            ) AS details,
            CASE WHEN f.photo_data_url <> '' THEN jsonb_build_array(f.photo_data_url) ELSE '[]'::jsonb END AS photos
     FROM delivery_fulfillment_records f
     LEFT JOIN delivery_orders o ON o.netsuite_id = f.order_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'itemName', l.item_name,
         'description', l.item_description,
         'pallets', l.packed_pallet_qty,
         'layers', l.packed_layer_qty,
         'sections', l.packed_section_qty,
         'pieces', l.packed_piece_qty,
         'salesQuantity', NULLIF(item.value->>'quantity', '')::numeric
       ) ORDER BY l.line_id NULLS LAST, l.id) AS lines
       FROM jsonb_array_elements(COALESCE(f.payload->'item'->'items', '[]'::jsonb)) item(value)
       LEFT JOIN delivery_order_lines l
         ON l.order_id = f.order_id
        AND l.line_id = CASE
          WHEN o.order_type = 'transfer_order' THEN NULLIF(item.value->>'orderLine', '')::bigint - 1
          ELSE NULLIF(item.value->>'orderLine', '')::bigint
        END
       WHERE item.value->>'itemReceive' IS DISTINCT FROM 'false'
         AND NULLIF(item.value->>'quantity', '') IS NOT NULL
     ) fulfilled_lines ON true
     WHERE f.operator_id = $1
       ${fulfillmentDate}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT ${safeLimit}`,
    fulfillmentParams
  );
  records.push(...fulfillments.rows.map(normalizeRecord));

  const receiptParams = [operatorId];
  const receiptDate = dateClause("r", date, receiptParams);
  const receipts = await query(
    `SELECT ('receipt-' || r.id) AS id,
            'item_receipt' AS type,
            'receiving.order.receive' AS action,
            'Item Receipt' AS title,
            r.order_id,
            o.tranid,
            COALESCE(r.item_receipt_tranid, r.item_receipt_id::text, '') AS reference,
            r.receipt_status AS status,
            r.created_at,
            jsonb_build_object(
              'recordId', r.id,
              'itemReceiptId', r.item_receipt_id,
              'itemReceiptTranid', r.item_receipt_tranid,
              'orderType', o.order_type,
              'lines', COALESCE(received_lines.lines, '[]'::jsonb),
              'payload', r.payload,
              'response', r.response
            ) AS details,
            r.photo_data_urls AS photos
     FROM receiving_receipt_records r
     LEFT JOIN receiving_orders o ON o.netsuite_id = r.order_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'itemName', l.item_name,
         'description', l.item_description,
         'pallets', l.received_pallet_qty,
         'layers', l.received_layer_qty,
         'sections', l.received_section_qty,
         'pieces', l.received_piece_qty,
         'salesQuantity', NULLIF(item.value->>'quantity', '')::numeric
       ) ORDER BY l.line_id NULLS LAST, l.id) AS lines
       FROM jsonb_array_elements(COALESCE(r.payload->'item'->'items', '[]'::jsonb)) item(value)
       LEFT JOIN receiving_order_lines l
         ON l.order_id = r.order_id
        AND l.line_id = NULLIF(item.value->>'orderLine', '')::bigint
       WHERE item.value->>'itemReceive' IS DISTINCT FROM 'false'
         AND NULLIF(item.value->>'quantity', '') IS NOT NULL
     ) received_lines ON true
     WHERE r.operator_id = $1
       ${receiptDate}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ${safeLimit}`,
    receiptParams
  );
  records.push(...receipts.rows.map(normalizeRecord));

  const cycleParams = [operatorId];
  const cycleDate = date ? " AND COALESCE(r.submitted_at, r.updated_at)::date = $2::date" : "";
  if (date) cycleParams.push(String(date).slice(0, 10));
  const cycle = await query(
    `SELECT ('cycle-' || r.id) AS id,
            'cycle_count' AS type,
            'cycle_count.submit' AS action,
            'Cycle Count' AS title,
            NULL::bigint AS order_id,
            ('Cycle #' || r.id) AS tranid,
            COUNT(l.id)::text || ' lines' AS reference,
            r.status,
            COALESCE(r.submitted_at, r.updated_at) AS created_at,
            jsonb_build_object(
              'recordId', r.id,
              'lineCount', COUNT(l.id),
              'totalAbsVariance', COALESCE(SUM(ABS(COALESCE(l.variance_qty, 0))), 0),
              'lines', COALESCE(jsonb_agg(
                jsonb_build_object(
                  'itemName', i.item_name,
                  'description', i.item_description,
                  'location', b.location,
                  'countedPallets', l.counted_pallet_qty,
                  'countedLayers', l.counted_layer_qty,
                  'countedSections', l.counted_section_qty,
                  'countedPieces', l.counted_piece_qty,
                  'countedTotal', l.counted_total_qty,
                  'systemOnHand', l.system_on_hand_qty,
                  'systemAvailable', l.system_available_qty,
                  'variance', l.variance_qty
                )
                ORDER BY l.confirmed_at DESC
              ) FILTER (WHERE l.id IS NOT NULL), '[]'::jsonb)
            ) AS details,
            '[]'::jsonb AS photos
     FROM cycle_count_records r
     LEFT JOIN cycle_count_lines l ON l.record_id = r.id
     LEFT JOIN inventory_items i ON i.item_id = l.item_id
     LEFT JOIN inventory_balances b ON b.item_id = l.item_id AND b.location_id = l.location_id
     WHERE r.operator_id = $1
       AND r.status = 'submitted'
       ${cycleDate}
     GROUP BY r.id
     ORDER BY COALESCE(r.submitted_at, r.updated_at) DESC
     LIMIT ${safeLimit}`,
    cycleParams
  );
  records.push(...cycle.rows.map(normalizeRecord));

  return records
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, safeLimit);
}

export async function findOperatorHistoryRecord(operatorId, recordId) {
  const records = await listOperatorHistory({ operatorId, limit: 200 });
  return records.find((record) => record.id === recordId) || null;
}

export async function reportOperatorRecordError({ operatorId, recordId, reason }) {
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) throw new Error("Please enter what was wrong with this record.");
  const record = await findOperatorHistoryRecord(operatorId, recordId);
  if (!record) throw new Error("History record not found.");

  const inserted = await query(
    `INSERT INTO operator_record_warnings (
       operator_id, record_type, record_id, reference, reason, details
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      operatorId,
      record.type,
      record.id,
      record.reference || record.tranid || "",
      cleanReason,
      JSON.stringify(record)
    ]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    source: "history",
    action: "operator.record_error_reported",
    details: { warningId: inserted.rows[0].id, recordId: record.id, recordType: record.type, reference: record.reference, reason: cleanReason }
  });

  return inserted.rows[0];
}

export async function listRecordWarnings({ status = "", limit = 100 } = {}) {
  const params = [];
  const clauses = [];
  if (status) {
    params.push(status);
    clauses.push(`w.status = $${params.length}`);
  }
  params.push(cleanLimit(limit));
  const result = await query(
    `SELECT w.*,
            op.display_name AS operator_name,
            op.username AS operator_username,
            handler.display_name AS handled_by_name
     FROM operator_record_warnings w
     LEFT JOIN operators op ON op.id = w.operator_id
     LEFT JOIN operators handler ON handler.id = w.handled_by
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY CASE WHEN w.status = 'open' THEN 0 ELSE 1 END, w.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function resolveRecordWarning({ warningId, handledBy, resolution }) {
  const cleanResolution = String(resolution || "").trim();
  if (!cleanResolution) throw new Error("Resolution note is required.");
  const result = await query(
    `UPDATE operator_record_warnings
     SET status = 'resolved',
         handled_by = $2,
         handled_at = now(),
         resolution = $3
     WHERE id = $1
     RETURNING *`,
    [warningId, handledBy || null, cleanResolution]
  );
  if (!result.rowCount) throw new Error("Warning not found.");

  await writeAudit({
    actorOperatorId: handledBy,
    source: "control",
    action: "operator.record_warning_resolved",
    details: { warningId, resolution: cleanResolution }
  });

  return result.rows[0];
}
