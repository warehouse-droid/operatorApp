WITH pickup_line_totals AS (
  SELECT
    sales_order_id,
    SUM(COALESCE(quantity, 0)) AS required_qty,
    SUM(COALESCE(loaded_qty, 0)) AS loaded_qty
  FROM sales_order_lines
  WHERE netsuite_active = true
  GROUP BY sales_order_id
)
UPDATE sales_orders s
   SET local_yard_order_status = CASE
         WHEN COALESCE(t.loaded_qty, 0) > 0
              AND COALESCE(t.loaded_qty, 0) >= COALESCE(t.required_qty, 0)
           THEN 'loaded'
         WHEN COALESCE(t.loaded_qty, 0) > 0
           THEN 'partial_loaded'
         ELSE COALESCE(NULLIF(s.local_yard_order_status, ''), 'Open')
       END,
       operator_status = CASE
         WHEN COALESCE(t.loaded_qty, 0) > 0
              AND COALESCE(t.loaded_qty, 0) >= COALESCE(t.required_qty, 0)
           THEN 'loaded'
         WHEN COALESCE(t.loaded_qty, 0) > 0
           THEN 'partial_loaded'
         ELSE COALESCE(NULLIF(s.operator_status, ''), 'open')
       END
  FROM pickup_line_totals t
 WHERE s.netsuite_id = t.sales_order_id
   AND s.sales_order_type = 'Pick-Up';
