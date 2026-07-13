BEGIN;

CREATE TEMP TABLE split_restore_source ON COMMIT DROP AS
SELECT
  split_order->>'id' AS split_id,
  split_order->'items' AS items
FROM dispatch_plan_snapshots snapshot
CROSS JOIN LATERAL jsonb_array_elements(snapshot.orders) split_order
WHERE snapshot.plan_id = 13
  AND split_order->>'id' IN ('TOB00521-S3', 'TOB00521-S4');

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM split_restore_source) <> 2 THEN
    RAISE EXCEPTION 'Expected intact TOB00521-S3/S4 items in plan 13; repair stopped.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM split_restore_source
    WHERE jsonb_array_length(COALESCE(items, '[]'::jsonb)) = 0
  ) THEN
    RAISE EXCEPTION 'An intact split has no items; repair stopped.';
  END IF;
END $$;

CREATE TEMP TABLE affected_snapshots ON COMMIT DROP AS
SELECT
  plan.id AS plan_id,
  plan.plan_date,
  plan.revision,
  snapshot.orders,
  snapshot.trucks,
  snapshot.summary,
  snapshot.saved_at
FROM dispatch_plans plan
JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(snapshot.orders) split_order
  WHERE split_order->>'id' IN ('TOB00521-S3', 'TOB00521-S4')
    AND (
      COALESCE(split_order->>'originalOrderId', '') <> 'TOB00521'
      OR jsonb_array_length(COALESCE(split_order->'items', '[]'::jsonb)) = 0
    )
);

INSERT INTO dispatch_plan_snapshot_history (
  plan_id,
  plan_date,
  revision,
  orders,
  trucks,
  summary,
  original_saved_at,
  archive_reason,
  session_id
)
SELECT
  plan_id,
  plan_date,
  revision,
  orders,
  trucks,
  summary,
  saved_at,
  'before_split_line_repair',
  'codex-local-repair'
FROM affected_snapshots;

WITH rebuilt_orders AS (
  SELECT
    affected.plan_id,
    jsonb_agg(
      CASE
        WHEN split_order.value->>'id' IN ('TOB00521-S3', 'TOB00521-S4') THEN
          split_order.value || jsonb_build_object(
            'originalOrderId', 'TOB00521',
            'items', restore.items,
            'raw', COALESCE(split_order.value->'raw', '{}'::jsonb)
              || jsonb_build_object('items', restore.items)
          )
        ELSE split_order.value
      END
      ORDER BY split_order.ordinality
    ) AS orders
  FROM affected_snapshots affected
  CROSS JOIN LATERAL jsonb_array_elements(affected.orders)
    WITH ORDINALITY split_order(value, ordinality)
  LEFT JOIN split_restore_source restore
    ON restore.split_id = split_order.value->>'id'
  GROUP BY affected.plan_id
)
UPDATE dispatch_plan_snapshots snapshot
SET
  orders = rebuilt.orders,
  saved_at = now()
FROM rebuilt_orders rebuilt
WHERE snapshot.plan_id = rebuilt.plan_id;

UPDATE dispatch_plans plan
SET
  revision = plan.revision + 1,
  updated_at = now()
WHERE plan.id IN (SELECT plan_id FROM affected_snapshots);

DELETE FROM transfer_order_lines
WHERE transfer_order_id IN (
  SELECT netsuite_id
  FROM transfer_orders
  WHERE tranid IN ('TOB00521-S3', 'TOB00521-S4')
)
  AND line_stage = 'outbound'
  AND COALESCE(loaded_qty, 0) = 0
  AND COALESCE(packed_pallet_qty, 0) = 0
  AND COALESCE(packed_layer_qty, 0) = 0
  AND COALESCE(packed_section_qty, 0) = 0
  AND COALESCE(packed_piece_qty, 0) = 0;

INSERT INTO transfer_order_lines (
  line_stage,
  transfer_order_id,
  line_id,
  item_id,
  item_name,
  sku,
  item_description,
  quantity,
  unit,
  pallet_qty,
  layer_qty,
  section_qty,
  piece_qty,
  loaded_qty,
  loaded_uom,
  netsuite_active,
  synced_at,
  item_type,
  item_type_text,
  location_id,
  location,
  to_plt,
  to_lyr,
  to_sec,
  to_pcs,
  item_weight,
  raw,
  confirmed,
  fulfilled_pallet_qty,
  fulfilled_layer_qty,
  fulfilled_piece_qty,
  fulfilled_section_qty
)
SELECT
  'outbound',
  split_header.netsuite_id,
  source_line.line_id,
  source_line.item_id,
  source_line.item_name,
  source_line.sku,
  source_line.item_description,
  (item.value->>'quantity')::numeric,
  source_line.unit,
  COALESCE((item.value->>'pallets')::numeric, 0),
  COALESCE((item.value->>'layers')::numeric, 0),
  COALESCE((item.value->>'sections')::numeric, 0),
  COALESCE((item.value->>'pieces')::numeric, 0),
  0,
  source_line.unit,
  true,
  now(),
  source_line.item_type,
  source_line.item_type_text,
  source_line.location_id,
  source_line.location,
  source_line.to_plt,
  source_line.to_lyr,
  source_line.to_sec,
  source_line.to_pcs,
  source_line.item_weight,
  jsonb_build_object(
    'restoredFromPlanId', 13,
    'restoredSplitItem', item.value
  ),
  false,
  0,
  0,
  0,
  0
FROM split_restore_source restore
JOIN transfer_orders split_header ON split_header.tranid = restore.split_id
CROSS JOIN LATERAL jsonb_array_elements(restore.items) item(value)
JOIN LATERAL (
  SELECT source.*
  FROM transfer_orders source_header
  JOIN transfer_order_lines source
    ON source.transfer_order_id = source_header.netsuite_id
   AND source.line_stage = 'outbound'
  WHERE source_header.tranid = 'TOB00521'
    AND source.line_id::text = item.value->>'lineId'
  ORDER BY source.id
  LIMIT 1
) source_line ON true
ON CONFLICT (transfer_order_id, line_stage, line_id) WHERE line_id IS NOT NULL DO UPDATE
SET
  item_id = EXCLUDED.item_id,
  item_name = EXCLUDED.item_name,
  sku = EXCLUDED.sku,
  item_description = EXCLUDED.item_description,
  quantity = EXCLUDED.quantity,
  unit = EXCLUDED.unit,
  pallet_qty = EXCLUDED.pallet_qty,
  layer_qty = EXCLUDED.layer_qty,
  section_qty = EXCLUDED.section_qty,
  piece_qty = EXCLUDED.piece_qty,
  netsuite_active = true,
  synced_at = now(),
  item_type = EXCLUDED.item_type,
  item_type_text = EXCLUDED.item_type_text,
  location_id = EXCLUDED.location_id,
  location = EXCLUDED.location,
  to_plt = EXCLUDED.to_plt,
  to_lyr = EXCLUDED.to_lyr,
  to_sec = EXCLUDED.to_sec,
  to_pcs = EXCLUDED.to_pcs,
  item_weight = EXCLUDED.item_weight,
  raw = EXCLUDED.raw;

INSERT INTO dispatch_audit_log (
  action,
  entity_type,
  entity_id,
  order_id,
  session_id,
  operator_name,
  source,
  details,
  plan_id,
  plan_date
)
SELECT
  'dispatch.split.lines_repaired',
  'order',
  'TOB00521',
  'TOB00521',
  'codex-local-repair',
  'system',
  'dispatch',
  jsonb_build_object(
    'splitOrders', jsonb_build_array('TOB00521-S3', 'TOB00521-S4'),
    'restoredLineCount', (
      SELECT COUNT(*)
      FROM transfer_order_lines lines
      JOIN transfer_orders orders ON orders.netsuite_id = lines.transfer_order_id
      WHERE orders.tranid IN ('TOB00521-S3', 'TOB00521-S4')
        AND lines.line_stage = 'outbound'
    ),
    'archiveReason', 'before_split_line_repair'
  ),
  affected.plan_id,
  affected.plan_date
FROM affected_snapshots affected;

COMMIT;
