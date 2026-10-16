import { query } from "./db.js";

/** @param {string[]} [orderRefs] */
export async function assertSalesOrderSplitUnallocated(orderRefs = []) {
  const refs = [...new Set(orderRefs.map(ref => String(ref || "").trim().toLowerCase()).filter(Boolean))];
  if (!refs.length) return;
  const result = await query(`WITH requested AS (
    SELECT ref, definition.parent_order_ref FROM unnest($1::text[]) ref
    LEFT JOIN dispatch_global_order_splits definition ON lower(definition.split_ref)=ref
  ), links AS (
    SELECT 'PO' AS kind, po_order_ref AS linked_ref, sales_order_ref, dispatch_target_ref, dispatch_target_kind
      FROM dispatch_so_po_allocations WHERE status='active'
    UNION ALL
    SELECT 'TO', transfer_order_ref, sales_order_ref, dispatch_target_ref, dispatch_target_kind
      FROM order_dependencies WHERE status<>'cancelled'
  ) SELECT DISTINCT requested.ref, links.kind, links.linked_ref FROM requested JOIN links ON
    lower(btrim(COALESCE(NULLIF(links.dispatch_target_ref,''),links.sales_order_ref)))=requested.ref
    OR (links.dispatch_target_kind<>'split' AND lower(btrim(links.sales_order_ref))=requested.ref)
    OR lower(btrim(COALESCE(NULLIF(links.dispatch_target_ref,''),links.sales_order_ref)))=lower(requested.parent_order_ref)
    ORDER BY requested.ref,links.kind,links.linked_ref`, [refs]);
  if (result.rows.length) {
    const kinds = [...new Set(result.rows.map((/** @type {{kind: string}} */ row) => row.kind))].join(" and ");
    throw Object.assign(new Error(`Cannot split this Sales Order. Unlink its ${kinds} allocations first.`), {
      status: 409, code: "DISPATCH_SPLIT_ALLOCATED", allocations: result.rows
    });
  }
}
