ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS loaded_qty numeric NOT NULL DEFAULT 0;

ALTER TABLE customer_pickup_load_records
  ADD COLUMN IF NOT EXISTS loaded_qty numeric NOT NULL DEFAULT 0;

UPDATE delivery_order_lines
   SET loaded_qty = GREATEST(
     COALESCE(loaded_qty, 0),
     CASE
       WHEN COALESCE(to_plt, 0) <> 0
         OR COALESCE(to_lyr, 0) <> 0
         OR COALESCE(to_sec, 0) <> 0
         OR COALESCE(to_pcs, 0) <> 0
       THEN (COALESCE(loaded_pallet_qty, pickup_loaded_pallet_qty, 0) * COALESCE(to_plt, 0))
          + (COALESCE(loaded_layer_qty, pickup_loaded_layer_qty, 0) * COALESCE(to_lyr, 0))
          + (COALESCE(loaded_section_qty, pickup_loaded_section_qty, 0) * COALESCE(to_sec, 0))
          + (COALESCE(loaded_piece_qty, pickup_loaded_piece_qty, 0) * COALESCE(to_pcs, 0))
       ELSE COALESCE(loaded_piece_qty, pickup_loaded_piece_qty, 0)
     END
   );
