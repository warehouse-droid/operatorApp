-- Preserve exact materialized split identity while retaining parent-to-child matching.
-- Completion evidence, quantity coverage, and receipt admission contracts stay unchanged.
CREATE OR REPLACE FUNCTION dispatch_po_allocation_delivery_refs(raw_allocation_id bigint)
RETURNS text[] LANGUAGE sql STABLE AS $$
  WITH allocation AS (
    SELECT allocation.*, source.line_id AS source_line_key, definition.group_ref,
      definition.full_order
    FROM dispatch_so_po_allocations allocation
    JOIN sales_order_lines source ON source.id=allocation.sales_line_id
    LEFT JOIN dispatch_global_order_groups definition
      ON allocation.dispatch_target_kind='group' AND definition.order_type='SO'
      AND lower(btrim(definition.group_ref))=lower(btrim(allocation.dispatch_target_ref))
    WHERE allocation.id=raw_allocation_id AND allocation.status='active'
  ), matched AS (
    SELECT btrim(child.detail->>'id') AS ref,
      COALESCE(CASE WHEN jsonb_typeof(item.detail->'splitQty')='number'
        THEN (item.detail->>'splitQty')::numeric
        WHEN jsonb_typeof(item.detail->'quantity')='number'
        THEN (item.detail->>'quantity')::numeric END,0) AS quantity,
      CASE WHEN jsonb_typeof(item.detail->'pallets')='number' THEN (item.detail->>'pallets')::numeric ELSE 0 END AS pallets,
      CASE WHEN jsonb_typeof(item.detail->'layers')='number' THEN (item.detail->>'layers')::numeric ELSE 0 END AS layers,
      CASE WHEN jsonb_typeof(item.detail->'sections')='number' THEN (item.detail->>'sections')::numeric ELSE 0 END AS sections,
      CASE WHEN jsonb_typeof(item.detail->'pieces')='number' THEN (item.detail->>'pieces')::numeric ELSE 0 END AS pieces
    FROM allocation
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(full_order->'childOrderDetails')='array'
      THEN full_order->'childOrderDetails' ELSE '[]'::jsonb END) child(detail)
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(child.detail->'items')='array'
      THEN child.detail->'items' ELSE '[]'::jsonb END) item(detail)
    WHERE upper(COALESCE(child.detail->>'type',''))='SO'
      AND full_order->'childOrders' ? (child.detail->>'id')
      AND (
        lower(btrim(child.detail->>'id'))=lower(btrim(allocation.sales_order_ref))
        OR lower(regexp_replace(btrim(child.detail->>'id'),'-S[0-9]+$','','i'))=lower(btrim(allocation.sales_order_ref))
      )
      AND (item.detail->>'lineRowId'=allocation.sales_line_id::text
        OR item.detail->>'sourceLineId'=allocation.sales_line_id::text
        OR item.detail->>'lineId'=allocation.source_line_key::text)
      AND COALESCE(item.detail->>'itemId',allocation.item_id::text)=allocation.item_id::text
  )
  SELECT CASE WHEN allocation.group_ref IS NOT NULL THEN COALESCE((
    SELECT CASE WHEN SUM(quantity)+0.000001>=allocation.allocated_sales_qty
      AND SUM(pallets)+0.000001>=allocation.allocated_pallet_qty
      AND SUM(layers)+0.000001>=allocation.allocated_layer_qty
      AND SUM(sections)+0.000001>=allocation.allocated_section_qty
      AND SUM(pieces)+0.000001>=allocation.allocated_piece_qty
      THEN array_agg(DISTINCT ref ORDER BY ref) ELSE '{}'::text[] END FROM matched
  ),'{}'::text[]) ELSE ARRAY[btrim(CASE WHEN allocation.dispatch_target_kind='group'
    THEN allocation.sales_order_ref ELSE COALESCE(NULLIF(allocation.dispatch_target_ref,''),allocation.sales_order_ref) END)] END
  FROM allocation
$$;
