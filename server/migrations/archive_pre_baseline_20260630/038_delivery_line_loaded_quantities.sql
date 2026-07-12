ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS loaded_pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loaded_layer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loaded_piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loaded_section_qty numeric NOT NULL DEFAULT 0;

UPDATE delivery_order_lines
   SET loaded_pallet_qty = GREATEST(COALESCE(loaded_pallet_qty, 0), COALESCE(pickup_loaded_pallet_qty, 0)),
       loaded_layer_qty = GREATEST(COALESCE(loaded_layer_qty, 0), COALESCE(pickup_loaded_layer_qty, 0)),
       loaded_piece_qty = GREATEST(COALESCE(loaded_piece_qty, 0), COALESCE(pickup_loaded_piece_qty, 0)),
       loaded_section_qty = GREATEST(COALESCE(loaded_section_qty, 0), COALESCE(pickup_loaded_section_qty, 0));
