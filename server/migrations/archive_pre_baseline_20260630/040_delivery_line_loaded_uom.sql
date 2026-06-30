ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS loaded_uom text;

UPDATE delivery_order_lines
   SET loaded_uom = COALESCE(NULLIF(loaded_uom, ''), NULLIF(unit, ''))
 WHERE COALESCE(loaded_qty, 0) > 0;

ALTER TABLE customer_pickup_load_records
  ADD COLUMN IF NOT EXISTS loaded_uom text;
