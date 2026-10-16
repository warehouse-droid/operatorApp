// @ts-check
import { query } from "./db.js";

/** @param {any} value */
const text = (/** @type {any} */ value) => String(value ?? "").trim();
/** @param {any} line */
export function operatorLineHasPacking(line) {
  return line.confirmed === true || Boolean(line.confirmed_at) || ["packed_pallet_qty", "packed_layer_qty",
    "packed_section_qty", "packed_piece_qty", "packed_sales_qty"].some((/** @type {any} */ field) => Number(line[field] || 0) > 0);
}
/** @param {any} header @param {any[]} lines */
export function operatorProgressStatus(header, lines) {
  if (lines.some((/** @type {any} */ line) => Number(line.loaded_qty || 0) > 0)
      || header.loaded_at || [header.operator_status, header.outbound_operator_status, header.local_yard_order_status]
        .some((/** @type {any} */ value) => /^(loaded|partial_loaded|fulfilled|shipped|received|complete|completed)$/iu.test(text(value)))) { return "loaded"; }
  if (lines.some(operatorLineHasPacking)
      || [header.operator_status, header.outbound_operator_status, header.status].some((/** @type {any} */ value) => /^(packed|confirmed)$/iu.test(text(value)))) { return "packed"; }
  return header.preparing_operator_id || header.preparing_started_at
    || [header.operator_status, header.outbound_operator_status, header.status].some((/** @type {any} */ value) => text(value).toLowerCase() === "preparing") ? "preparing" : "open";
}

/** @param {{orderId: any, orderRef: string, status: string, preparingOperatorId?: any, correctionKey?: string}} input */
export async function readOperatorProgressActor({ orderId, orderRef, status, preparingOperatorId, correctionKey }) {
  const keys = correctionKey ? [correctionKey] : ["sales_order:", "transfer_order:"].map(kind => kind + orderId);
  const audit = await query(`SELECT a.actor_operator_id FROM delivery_audit_log a
    WHERE (a.order_id=$1 OR a.details->'childOrders' @> jsonb_build_array($1::bigint)
      OR a.details->'childOrders' @> jsonb_build_array($1::text)
      OR a.details->>'vrmaRef'=$2 OR a.details->>'coRef'=$2)
      AND a.actor_operator_id IS NOT NULL AND a.action LIKE 'delivery.%'
      AND (CASE WHEN $3='loaded' THEN a.action ~ '\\.(load|fulfill)$'
        ELSE a.action ~ '\\.(confirm|update_packed_quantity|packed)$'
          OR (a.action ~ '\\.status$' AND a.details->>'status' IN ('packed','preparing')) END)
      AND a.created_at > COALESCE((SELECT max(created_at) FROM operator_order_reopens
        WHERE order_keys && $4::text[]),'-infinity')
    ORDER BY a.created_at DESC,a.id DESC LIMIT 1`, [orderId, orderRef, status, keys]);
  const load = status === "loaded" ? (await query(`SELECT operator_id FROM operator_load_records
    WHERE (order_id=$1 OR order_ref=$2) AND operator_id IS NOT NULL
      AND created_at > COALESCE((SELECT max(created_at) FROM operator_order_reopens
        WHERE order_keys && $3::text[]),'-infinity')
    ORDER BY created_at DESC,id DESC LIMIT 1`, [orderId, orderRef, keys])).rows[0] : null;
  const actorId = status === "preparing" && preparingOperatorId ? preparingOperatorId
    : load?.operator_id || audit.rows[0]?.actor_operator_id || (status === "loaded" ? null : preparingOperatorId);
  if (!actorId) { return null; }
  const row = (await query("SELECT id,username,display_name FROM operators WHERE id=$1", [actorId])).rows[0];
  return row ? { id: row.id, username: row.username, displayName: row.display_name || row.username } : null;
}

/** @param {string[]} refs */
export async function getOperatorProgressDetails(refs) {
  const result = await query(`SELECT 'sales_order' AS kind,s.tranid,s.netsuite_id,s.operator_status,
      s.local_yard_order_status,s.preparing_operator_id,
      COALESCE((SELECT jsonb_agg(l) FROM sales_order_lines l WHERE l.sales_order_id=s.netsuite_id),'[]') AS lines
    FROM sales_orders s WHERE s.tranid=ANY($1::text[])
    UNION ALL SELECT 'transfer_order',t.tranid,t.netsuite_id,t.outbound_operator_status,
      t.local_yard_order_status,t.preparing_operator_id,
      COALESCE((SELECT jsonb_agg(l) FROM transfer_order_lines l WHERE l.transfer_order_id=t.netsuite_id AND l.line_stage='outbound'),'[]')
    FROM transfer_orders t WHERE t.tranid=ANY($1::text[]) ORDER BY tranid`, [refs]);
  const orders = [];
  for (const row of result.rows) {
    const co = row.kind === "sales_order" ? (await query(`SELECT * FROM local_co_orders
      WHERE (source_order_ref=$1 OR details->'childOrderIds' ? $1) AND status<>'cancelled'
        AND (loaded_at IS NOT NULL OR received_at IS NOT NULL OR status IN ('loaded','received','completed'))
      ORDER BY updated_at DESC,id DESC LIMIT 1`, [row.tranid])).rows[0] : null;
    const status = co ? "loaded" : operatorProgressStatus(row, row.lines);
    orders.push({ orderRef: row.tranid, status, ...(co ? { viaOrderRef: co.co_ref } : {}),
      operator: await readOperatorProgressActor({ orderId: co ? co.delivery_order_id || -Number(co.id) : row.netsuite_id,
        orderRef: co ? co.co_ref : row.tranid, status,
        preparingOperatorId: co ? co.preparing_operator_id : row.preparing_operator_id,
        ...(co ? { correctionKey: `co_order:${co.id}` } : {}) }) });
  }
  return orders;
}

/** @param {any} order */
export function operatorReopenOrderKeys(order) {
  return [order, ...(order?.child_orders || [])].filter((/** @type {any} */ row) => !row.is_dispatch_group).map((/** @type {any} */ row) =>
    `${row.order_type}:${row.local_co_id ?? row.vrma_order_id ?? row.netsuite_id}`);
}

/** @param {any} order */
export async function retainedOperatorReopenEvidence(order) {
  if (!order) { return null; }
  const rows = (await query(`SELECT id,created_at,reason,retained_photo_refs,order_keys
    FROM operator_order_reopens WHERE order_keys && $1::text[] ORDER BY created_at DESC,id DESC`,
  [operatorReopenOrderKeys(order)])).rows;
  if (!rows.length) { return null; }
  const references = [...new Set(rows.flatMap((/** @type {any} */ row) => row.retained_photo_refs))];
  return { correctionId: rows[0].id, reopenedAt: rows[0].created_at,
    retainedPhotoReferences: references, retainedPhotoCount: references.length };
}
