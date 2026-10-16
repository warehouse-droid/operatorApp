// @ts-check
import { query } from "./db.js";
import { operatorProgressStatus } from "./operator-order-progress-repository.js";
import { assertSalesOrderSplitUnallocated } from "./dispatch-sales-split-allocation.js";

/** @param {string} code @param {string} message @param {number} status */
const failure = (code, message, status) => Object.assign(new Error(message), { code, status });
/** @param {any} line */
function previewItem(line) {
  return { lineRowId: line.id, lineId: line.line_id == null ? null : Number(line.line_id), itemId: line.item_id == null ? null : Number(line.item_id),
    sku: line.sku || line.item_name, itemName: line.item_name, description: line.item_description,
    itemType: line.item_type, itemTypeText: line.item_type_text, unit: line.unit,
    quantity: Number(line.quantity || 0), pallets: Number(line.pallet_qty || 0), layers: Number(line.layer_qty || 0),
    sections: Number(line.section_qty || 0), pieces: Number(line.piece_qty || 0),
    toPlt: Number(line.to_plt || 0), toLyr: Number(line.to_lyr || 0), toSec: Number(line.to_sec || 0), toPcs: Number(line.to_pcs || 0),
    itemWeight: Number(line.item_weight || 0), lineWeight: Number(line.quantity || 0) * Number(line.item_weight || 0) };
}

/** @param {{orderRef?: string, type?: string}} input */
export async function getDispatchSplitPreview({ orderRef = "", type = "" } = {}) {
  const ref = String(orderRef).trim(), kind = String(type).toUpperCase();
  if (!["SO", "TO"].includes(kind)) {
    throw failure("DISPATCH_SPLIT_TYPE_INVALID", "Choose a Sales Order or Transfer Order.", 400);
  }
  if (kind === "SO") await assertSalesOrderSplitUnallocated([ref]);
  const target = kind === "SO"
    ? { table: "sales_orders", lines: "sales_order_lines", parent: "sales_order_id", status: "operator_status" }
    : { table: "transfer_orders", lines: "transfer_order_lines", parent: "transfer_order_id", status: "outbound_operator_status" };
  const definition = (await query(`SELECT split_ref,parent_order_ref,active,full_order->'items' AS items
    FROM dispatch_global_order_splits WHERE split_ref=$1 AND order_type=$2 AND definition_kind='split'`, [ref, kind])).rows[0];
  if (definition?.active === false) {
    throw failure("DISPATCH_DERIVED_ORDER_RETIRED", `${ref} was retired. Refresh Orders.`, 409);
  }
  let headers = await query(`SELECT netsuite_id,tranid,netsuite_active,${target.status} AS operator_status,
    local_yard_order_status,preparing_operator_id,preparing_started_at
    FROM ${target.table} WHERE tranid=$1`, [ref]);
  let header = headers.rows[0];
  if (!header && definition) {
    headers = await query(`SELECT netsuite_id,tranid,netsuite_active,${target.status} AS operator_status,
      local_yard_order_status,preparing_operator_id,preparing_started_at FROM ${target.table} WHERE tranid=$1`,
    [definition.parent_order_ref]);
    header = headers.rows[0];
  }
  if (!header || header.netsuite_active === false || headers.rowCount > 1) {
    throw failure("DISPATCH_SPLIT_NOT_AVAILABLE", `${ref} is not a unique active order. Refresh Orders.`, 404);
  }
  const lines = (await query(`SELECT id,line_id,item_id,item_name,sku,item_description,item_type,item_type_text,
    quantity,unit,item_weight,pallet_qty,layer_qty,section_qty,piece_qty,to_plt,to_lyr,to_sec,to_pcs,netsuite_active,
    packed_pallet_qty,packed_layer_qty,packed_section_qty,packed_piece_qty,packed_sales_qty,loaded_qty,confirmed,confirmed_at
    FROM ${target.lines} WHERE ${target.parent}=$1 ${kind === "TO" ? "AND line_stage='outbound'" : ""}
    ORDER BY line_id NULLS LAST,id`, [header.netsuite_id])).rows;
  const co = kind === "SO" ? (await query(`SELECT 1 FROM local_co_orders WHERE status<>'cancelled'
    AND (source_order_ref=$1 OR details->'childOrderIds' ? $1)
    AND (loaded_at IS NOT NULL OR received_at IS NOT NULL OR status IN ('loaded','received','completed')) LIMIT 1`, [ref])).rowCount : 0;
  const status = co ? "loaded" : operatorProgressStatus(header, lines);
  return { id: ref, type: kind, operatorStatus: status,
    localYardOrderStatus: status === "loaded" ? "Loaded" : header.local_yard_order_status,
    items: definition?.items || lines.filter((/** @type {any} */ line) => line.netsuite_active !== false).map(previewItem) };
}
