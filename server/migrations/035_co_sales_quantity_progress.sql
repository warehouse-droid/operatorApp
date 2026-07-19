ALTER TABLE local_co_order_lines
  ADD COLUMN IF NOT EXISTS packed_sales_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS received_sales_qty numeric NOT NULL DEFAULT 0;

ALTER TABLE co_order_lines
  ADD COLUMN IF NOT EXISTS packed_sales_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS received_sales_qty numeric NOT NULL DEFAULT 0;

-- Preserve progress created before CO lines had a dedicated sales-UOM field.
-- The old UI only treated PALLET and lines without manual reference quantities
-- as sales-UOM-only, so those are the only safe rows to backfill automatically.
UPDATE local_co_order_lines
   SET packed_sales_qty = COALESCE(
         NULLIF(packed_piece_qty, 0),
         NULLIF(packed_section_qty, 0),
         NULLIF(packed_layer_qty, 0),
         NULLIF(packed_pallet_qty, 0),
         0
       )
 WHERE COALESCE(packed_sales_qty, 0) = 0
   AND COALESCE(quantity, 0) > 0
   AND COALESCE(to_plt, 0) = 0
   AND COALESCE(to_lyr, 0) = 0
   AND COALESCE(to_sec, 0) = 0
   AND COALESCE(to_pcs, 0) = 0
   AND (
     UPPER(COALESCE(NULLIF(sku, ''), item_name, '')) = 'PALLET'
     OR (
       COALESCE(pallet_qty, 0) = 0
       AND COALESCE(layer_qty, 0) = 0
       AND COALESCE(section_qty, 0) = 0
       AND COALESCE(piece_qty, 0) = 0
     )
   );

UPDATE local_co_order_lines
   SET received_sales_qty = COALESCE(
         NULLIF(received_piece_qty, 0),
         NULLIF(received_section_qty, 0),
         NULLIF(received_layer_qty, 0),
         NULLIF(received_pallet_qty, 0),
         0
       )
 WHERE COALESCE(received_sales_qty, 0) = 0
   AND COALESCE(quantity, 0) > 0
   AND COALESCE(to_plt, 0) = 0
   AND COALESCE(to_lyr, 0) = 0
   AND COALESCE(to_sec, 0) = 0
   AND COALESCE(to_pcs, 0) = 0
   AND (
     UPPER(COALESCE(NULLIF(sku, ''), item_name, '')) = 'PALLET'
     OR (
       COALESCE(pallet_qty, 0) = 0
       AND COALESCE(layer_qty, 0) = 0
       AND COALESCE(section_qty, 0) = 0
       AND COALESCE(piece_qty, 0) = 0
     )
   );

CREATE OR REPLACE FUNCTION mbbs_co_line_receiving_legacy_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE local_co_order_lines
     SET received_pallet_qty = NEW.received_pallet_qty,
         received_layer_qty = NEW.received_layer_qty,
         received_section_qty = NEW.received_section_qty,
         received_piece_qty = NEW.received_piece_qty,
         received_sales_qty = NEW.received_sales_qty,
         confirmed_at = NEW.confirmed_at,
         confirmed_by = NEW.confirmed_by
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN local_co_order_lines.packed_sales_qty IS
  'Source-yard packed quantity in the order line sales UOM when item conversion is unavailable.';
COMMENT ON COLUMN local_co_order_lines.received_sales_qty IS
  'Destination-yard received quantity in the order line sales UOM when item conversion is unavailable.';
