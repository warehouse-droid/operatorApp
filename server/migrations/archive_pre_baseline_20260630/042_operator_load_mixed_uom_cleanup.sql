ALTER TABLE customer_pickup_load_records
  ALTER COLUMN loaded_qty DROP NOT NULL;

WITH load_line_uoms AS (
  SELECT
    r.id,
    COUNT(DISTINCT NULLIF(l.loaded_uom, '')) AS uom_count,
    MIN(NULLIF(l.loaded_uom, '')) AS single_uom,
    SUM(COALESCE(l.loaded_qty, 0)) AS total_loaded_qty
  FROM customer_pickup_load_records r
  JOIN delivery_order_lines l ON l.order_id = r.order_id
  WHERE COALESCE(l.loaded_qty, 0) > 0
  GROUP BY r.id
)
UPDATE customer_pickup_load_records r
   SET loaded_qty = CASE WHEN u.uom_count = 1 THEN u.total_loaded_qty ELSE NULL END,
       loaded_uom = CASE WHEN u.uom_count = 1 THEN u.single_uom WHEN u.uom_count > 1 THEN 'MIXED' ELSE r.loaded_uom END
  FROM load_line_uoms u
 WHERE u.id = r.id;

WITH load_line_uoms AS (
  SELECT
    r.id,
    COUNT(DISTINCT line->>'loadedUom') FILTER (WHERE COALESCE(line->>'loadedUom', '') <> '') AS uom_count,
    MIN(line->>'loadedUom') FILTER (WHERE COALESCE(line->>'loadedUom', '') <> '') AS single_uom,
    SUM(COALESCE(NULLIF(line->>'loadedQty', '')::numeric, 0)) AS total_loaded_qty
  FROM operator_load_records r
  CROSS JOIN LATERAL jsonb_array_elements(r.line_snapshot) AS line
  GROUP BY r.id
)
UPDATE operator_load_records r
   SET loaded_qty = CASE WHEN u.uom_count = 1 THEN u.total_loaded_qty ELSE NULL END,
       loaded_uom = CASE WHEN u.uom_count = 1 THEN u.single_uom WHEN u.uom_count > 1 THEN 'MIXED' ELSE r.loaded_uom END
  FROM load_line_uoms u
 WHERE u.id = r.id;
