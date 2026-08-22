import { query } from "./db.js";
import { resolveDispatchSalesTarget } from "./dispatch-order-target-repository.js";

const MAX_LIMIT = 100;

function text(value) {
  return String(value ?? "").trim();
}

function cursorError() {
  return Object.assign(new Error("The SCM dependency search cursor is invalid."), {
    status: 400,
    code: "SCM_DEPENDENCY_SEARCH_CURSOR_INVALID"
  });
}

function decodeCursor(value) {
  if (!value) {return null;}
  try {
    const parsed = JSON.parse(Buffer.from(text(value), "base64url").toString("utf8"));
    if (!parsed || ![0, 1].includes(Number(parsed.e)) || typeof parsed.r !== "string" || parsed.r.length > 500) {
      throw cursorError();
    }
    return { exactRank: Number(parsed.e), ref: parsed.r.toLowerCase() };
  } catch (error) {
    if (error?.code === "SCM_DEPENDENCY_SEARCH_CURSOR_INVALID") {throw error;}
    throw cursorError();
  }
}

function encodeCursor(row = {}) {
  return Buffer.from(JSON.stringify({
    e: Number(row.exact_rank || 0),
    r: text(row.ref).toLowerCase()
  }), "utf8").toString("base64url");
}

export async function searchScmDependencyTargets({ search = "", cursor = "", limit = 50 } = {}) {
  const searchTerm = text(search).toLowerCase().slice(0, 120);
  const decoded = decodeCursor(cursor);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT);
  const result = await query(
    `WITH source_quantity AS (
       SELECT split.source_so_id,
              COALESCE(SUM(abs(COALESCE(line.quantity, 0))), 0) AS source_quantity
         FROM dispatch_scm_so_splits split
         JOIN sales_order_lines line ON line.sales_order_id = split.source_so_id
        WHERE split.status = 'active' AND COALESCE(line.netsuite_active, true)
        GROUP BY split.source_so_id
     ),
     child_quantity AS (
       SELECT split.source_so_id,
              COALESCE(SUM(abs(COALESCE(line.quantity, 0))), 0) AS child_quantity
         FROM dispatch_scm_so_splits split
         JOIN sales_order_lines line ON line.sales_order_id = split.split_so_id
        WHERE split.status = 'active' AND COALESCE(line.netsuite_active, true)
        GROUP BY split.source_so_id
     ),
     normal_targets AS (
       SELECT catalog.order_ref AS ref,
              'normal'::text AS kind,
              catalog.card,
              catalog.search_text,
              NULL::bigint AS plan_id,
              NULL::date AS plan_date,
              1::int AS member_count
         FROM dispatch_order_catalog_entries catalog
         JOIN sales_orders sales ON lower(sales.tranid) = lower(catalog.order_ref)
         LEFT JOIN source_quantity source ON source.source_so_id = sales.netsuite_id
         LEFT JOIN child_quantity child ON child.source_so_id = sales.netsuite_id
        WHERE catalog.order_type = 'SO'
          AND catalog.eligible = true
          AND COALESCE(sales.netsuite_active, true)
          AND upper(COALESCE(sales.status, '')) NOT IN ('C', 'H')
          AND COALESCE(sales.status_text, '') !~* '(closed|cancel)'
          AND NOT EXISTS (
            SELECT 1 FROM dispatch_scm_so_splits own_split
             WHERE own_split.split_so_id = sales.netsuite_id AND own_split.status = 'active'
          )
          AND (
            source.source_so_id IS NULL
            OR source.source_quantity > COALESCE(child.child_quantity, 0) + 0.000001
          )
     ),
     split_targets AS (
       SELECT split.split_so_ref AS ref,
              'split'::text AS kind,
              COALESCE(catalog.card, jsonb_build_object(
                'id', split.split_so_ref,
                'type', 'SO',
                'originalOrderId', split.source_so_ref
              )) AS card,
              lower(concat_ws(' ', split.split_so_ref, split.source_so_ref, sales.customer)) AS search_text,
              NULL::bigint AS plan_id,
              NULL::date AS plan_date,
              1::int AS member_count
         FROM dispatch_scm_so_splits split
         JOIN sales_orders sales ON sales.netsuite_id = split.split_so_id
         LEFT JOIN dispatch_order_catalog_entries catalog
           ON lower(catalog.order_ref) = lower(split.split_so_ref)
        WHERE split.status = 'active'
          AND COALESCE(sales.netsuite_active, true)
          AND upper(COALESCE(sales.status, '')) NOT IN ('C', 'H')
          AND COALESCE(sales.status_text, '') !~* '(closed|cancel)'
     ),
     group_targets AS (
       SELECT group_row.group_ref AS ref,
              'group'::text AS kind,
              jsonb_build_object(
                'id', group_row.group_ref,
                'type', 'SO',
                'customer', string_agg(DISTINCT COALESCE(sales.customer, ''), ', '),
                'childOrders', jsonb_agg(member.member_order_ref ORDER BY member.position)
              ) AS card,
              lower(concat_ws(' ', group_row.group_ref,
                string_agg(member.member_order_ref, ' '),
                string_agg(DISTINCT COALESCE(sales.customer, ''), ' '))) AS search_text,
              group_row.plan_id,
              group_row.plan_date,
              count(*)::int AS member_count
         FROM dispatch_delivery_groups group_row
         JOIN dispatch_delivery_group_members member ON member.group_ref = group_row.group_ref
         LEFT JOIN sales_orders sales ON lower(sales.tranid) = lower(member.member_order_ref)
        WHERE group_row.active = true
          AND group_row.order_type = 'sales_order'
        GROUP BY group_row.group_ref, group_row.plan_id, group_row.plan_date
       HAVING bool_and(COALESCE(sales.netsuite_active, true))
          AND bool_and(upper(COALESCE(sales.status, '')) NOT IN ('C', 'H'))
          AND bool_and(COALESCE(sales.status_text, '') !~* '(closed|cancel)')
     ),
     candidates AS (
       SELECT * FROM normal_targets
       UNION ALL SELECT * FROM split_targets
       UNION ALL SELECT * FROM group_targets
     ),
     ranked AS (
       SELECT candidates.*,
              CASE WHEN $1 <> '' AND lower(ref) = $1 THEN 1 ELSE 0 END AS exact_rank
         FROM candidates
        WHERE $1 = '' OR lower(ref) = $1 OR search_text ILIKE ('%' || $1 || '%')
     )
     SELECT * FROM ranked
      WHERE $2::int IS NULL
         OR exact_rank < $2
         OR (exact_rank = $2 AND lower(ref) > $3)
      ORDER BY exact_rank DESC, lower(ref), kind
      LIMIT $4`,
    [searchTerm, decoded?.exactRank ?? null, decoded?.ref || "", safeLimit + 1]
  );
  const hasMore = result.rows.length > safeLimit;
  const page = result.rows.slice(0, safeLimit);
  return {
    targets: page.map((row) => ({
      ref: row.ref,
      kind: row.kind,
      card: row.card || {},
      planId: row.plan_id === null ? null : Number(row.plan_id),
      planDate: row.plan_date ? String(row.plan_date).slice(0, 10) : "",
      memberCount: Number(row.member_count || 1)
    })),
    nextCursor: hasMore && page.length ? encodeCursor(page.at(-1)) : "",
    source: "indexed-current-order-ledgers"
  };
}

export async function getScmDependencyTargetDetail({ targetRef, planDate = "" } = {}) {
  const resolved = await resolveDispatchSalesTarget({
    dispatchTargetRef: text(targetRef),
    planDate: text(planDate)
  });
  const [dependencies, poAllocations] = await Promise.all([
    query(
      `SELECT dependency.id, dependency.transfer_order_ref, dependency.dependency_mode,
              dependency.status, dependency.created_at,
              COALESCE(SUM(line.allocated_quantity), 0) AS allocated_quantity
         FROM order_dependencies dependency
         LEFT JOIN order_dependency_lines line ON line.dependency_id = dependency.id
        WHERE dependency.dispatch_target_ref = $1 AND dependency.status <> 'cancelled'
        GROUP BY dependency.id
        ORDER BY dependency.created_at, dependency.id`,
      [resolved.target.ref]
    ),
    query(
      `SELECT id, po_order_ref, status, created_at,
              allocated_pallet_qty, allocated_layer_qty, allocated_section_qty,
              allocated_piece_qty, allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE dispatch_target_ref = $1 AND status = 'active'
        ORDER BY created_at, id`,
      [resolved.target.ref]
    )
  ]);
  return {
    ...resolved,
    relationships: {
      transferOrders: dependencies.rows.map((row) => ({
        id: Number(row.id),
        transferOrderRef: row.transfer_order_ref,
        mode: row.dependency_mode,
        status: row.status,
        allocatedQuantity: Number(row.allocated_quantity || 0),
        createdAt: row.created_at
      })),
      purchaseOrders: poAllocations.rows.map((row) => ({
        id: Number(row.id),
        poOrderRef: row.po_order_ref,
        status: row.status,
        allocated: {
          pallets: Number(row.allocated_pallet_qty || 0),
          layers: Number(row.allocated_layer_qty || 0),
          sections: Number(row.allocated_section_qty || 0),
          pieces: Number(row.allocated_piece_qty || 0),
          salesQty: Number(row.allocated_sales_qty || 0)
        },
        createdAt: row.created_at
      }))
    }
  };
}
