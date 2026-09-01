import { query } from "./db.js";

const BLANKET_PENDING_ALLOCATION_STATUSES = Object.freeze(["reserved", "held"]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

function integer(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function smartScmBlanketBalanceByItem(poolRows = []) {
  const balances = new Map();
  for (const row of Array.isArray(poolRows) ? poolRows : []) {
    const itemId = Number(row.item_id ?? row.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) continue;
    const key = String(itemId);
    const current = balances.get(key) || {
      availableSalesQty: 0,
      availablePallets: 0,
      sourcePoRefs: []
    };
    current.availableSalesQty += positive(row.remaining_sales_qty ?? row.remainingSalesQty);
    current.availablePallets += positive(row.remaining_pallets ?? row.remainingPallets);
    const sourcePoRef = String(row.source_po_ref ?? row.sourcePoRef ?? "").trim();
    if (sourcePoRef && !current.sourcePoRefs.includes(sourcePoRef)) current.sourcePoRefs.push(sourcePoRef);
    balances.set(key, current);
  }
  return balances;
}

export async function listSmartScmBlanketPoolRows({
  search = "",
  isBlanket = null,
  sourcePoId = null,
  limit = 10000,
  offset = 0
} = {}) {
  const cleanSearch = String(search ?? "").trim().slice(0, 160);
  const selectedSourcePoId = integer(sourcePoId);
  const maxRows = Math.min(20000, Math.max(1, Number(limit) || 10000));
  const rowOffset = Math.max(0, Number(offset) || 0);
  const result = await query(
    `WITH sales_alloc AS (
       SELECT po_line_id,
              SUM(allocated_pallet_qty) AS pallet_qty,
              SUM(allocated_sales_qty) AS sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY po_line_id
     ), split_alloc AS (
       SELECT split_line.source_line_id,
              SUM(split_line.pallet_qty) AS pallet_qty,
              SUM(split_line.sales_qty) AS sales_qty
         FROM dispatch_scm_po_split_lines split_line
         JOIN dispatch_scm_po_splits split_header
           ON split_header.id = split_line.split_id
          AND split_header.status = 'active'
        GROUP BY split_line.source_line_id
     ), blanket_alloc AS (
       SELECT allocation.source_line_id,
              SUM(CASE
                WHEN allocation.status = 'reserved' THEN allocation.reserved_pallets
                WHEN allocation.status = 'held' THEN allocation.held_pallets
                ELSE 0
              END) AS pallet_qty,
              SUM(CASE
                WHEN allocation.status = 'reserved' THEN allocation.reserved_sales_qty
                WHEN allocation.status = 'held' THEN allocation.held_sales_qty
                ELSE 0
              END) AS sales_qty
         FROM scm_smart_blanket_allocations allocation
        WHERE allocation.status = ANY($6::text[])
        GROUP BY allocation.source_line_id
     ), calculated AS (
       SELECT po.netsuite_id AS source_po_id,
              po.tranid AS source_po_ref,
              po.trandate,
              po.vendor_id,
              po.vendor,
              COALESCE(NULLIF(po.dispatch_vendor_yard, ''), NULLIF(po.source_location, ''), po.vendor) AS pickup_point,
              po.status_text,
              po.is_blanket_po,
              po.blanket_flagged_at,
              po.blanket_flagged_by,
              line.id AS source_line_id,
              line.line_id,
              line.item_id,
              line.item_name,
              line.sku,
              line.item_description,
              line.unit,
              line.to_plt,
              line.to_lyr,
              line.to_sec,
              line.to_pcs,
              CASE WHEN COALESCE(line.item_weight, 0) > 0 AND COALESCE(line.to_plt, 0) > 0
                   THEN line.item_weight * line.to_plt ELSE 0 END AS pallet_weight_lbs,
              GREATEST(COALESCE(line.quantity, 0), 0) AS ordered_sales_qty,
              GREATEST(COALESCE(line.netsuite_received_baseline_qty, line.netsuite_received_qty, 0), 0) AS received_baseline_sales_qty,
              COALESCE(sales.sales_qty, 0) + COALESCE(split.sales_qty, 0) AS allocated_sales_qty,
              COALESCE(blanket.sales_qty, 0) AS reserved_sales_qty,
              GREATEST(
                COALESCE(line.quantity, 0)
                - COALESCE(line.netsuite_received_baseline_qty, line.netsuite_received_qty, 0)
                - COALESCE(sales.sales_qty, 0)
                - COALESCE(split.sales_qty, 0)
                - COALESCE(blanket.sales_qty, 0),
                0
              ) AS remaining_sales_qty,
              CASE WHEN COALESCE(line.to_plt, 0) > 0 THEN GREATEST(LEAST(
                FLOOR((GREATEST(
                  COALESCE(line.quantity, 0)
                  - COALESCE(line.netsuite_received_baseline_qty, line.netsuite_received_qty, 0)
                  - COALESCE(sales.sales_qty, 0)
                  - COALESCE(split.sales_qty, 0)
                  - COALESCE(blanket.sales_qty, 0),
                  0
                ) / line.to_plt) + 0.000001),
                CASE WHEN COALESCE(line.pallet_qty, 0) > 0
                  THEN GREATEST(
                    COALESCE(line.pallet_qty, 0)
                    - COALESCE(sales.pallet_qty, 0)
                    - COALESCE(split.pallet_qty, 0)
                    - COALESCE(blanket.pallet_qty, 0),
                    0
                  )
                  ELSE FLOOR((GREATEST(
                    COALESCE(line.quantity, 0)
                    - COALESCE(line.netsuite_received_baseline_qty, line.netsuite_received_qty, 0)
                    - COALESCE(sales.sales_qty, 0)
                    - COALESCE(split.sales_qty, 0)
                    - COALESCE(blanket.sales_qty, 0),
                    0
                  ) / line.to_plt) + 0.000001)
                END
              ), 0) ELSE 0 END AS remaining_pallets
         FROM purchase_orders po
         JOIN purchase_order_lines line
           ON line.purchase_order_id = po.netsuite_id
          AND line.netsuite_active = true
         LEFT JOIN sales_alloc sales ON sales.po_line_id = line.id
         LEFT JOIN split_alloc split ON split.source_line_id = line.id
         LEFT JOIN blanket_alloc blanket ON blanket.source_line_id = line.id
        WHERE po.netsuite_active = true
          AND line.item_id IS NOT NULL
          AND COALESCE(line.to_plt, 0) > 0
          AND COALESCE(line.item_weight, 0) > 0
          AND (po.status_text ILIKE '%Pending Receipt%' OR po.status_text ILIKE '%Partially Received%')
          AND NOT EXISTS (
            SELECT 1
              FROM dispatch_scm_po_splits child_split
             WHERE child_split.split_po_id = po.netsuite_id
          )
          AND ($1::bigint IS NULL OR po.netsuite_id = $1)
          AND ($2::boolean IS NULL OR po.is_blanket_po = $2)
          AND ($3 = '' OR concat_ws(' ', po.tranid, po.vendor, po.dispatch_vendor_yard,
                 po.source_location, line.item_id::text, line.item_name, line.sku, line.item_description) ILIKE '%' || $3 || '%')
     )
     SELECT *
       FROM calculated
      WHERE remaining_pallets > 0
      ORDER BY trandate NULLS LAST, source_po_id, source_line_id
      LIMIT $4 OFFSET $5`,
    [selectedSourcePoId, isBlanket, cleanSearch, maxRows, rowOffset, BLANKET_PENDING_ALLOCATION_STATUSES]
  );
  return result.rows;
}
