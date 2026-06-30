CREATE OR REPLACE FUNCTION mbbs_sales_line_operator_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE delivery_order_lines
     SET packed_pallet_qty = NEW.packed_pallet_qty,
         packed_layer_qty = NEW.packed_layer_qty,
         packed_section_qty = NEW.packed_section_qty,
         packed_piece_qty = NEW.packed_piece_qty,
         confirmed = NEW.confirmed,
         confirmed_at = NEW.confirmed_at,
         loaded_qty = NEW.loaded_qty,
         loaded_uom = NEW.loaded_uom,
         netsuite_active = NEW.netsuite_active,
         sync_exception = NEW.sync_exception,
         synced_at = NEW.synced_at
   WHERE id = NEW.id
     AND order_id = NEW.sales_order_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sales_lines_operator_legacy ON sales_order_lines;
CREATE TRIGGER trg_sales_lines_operator_legacy
AFTER UPDATE ON sales_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_sales_line_operator_legacy_trigger();

UPDATE delivery_order_lines d
   SET packed_pallet_qty = s.packed_pallet_qty,
       packed_layer_qty = s.packed_layer_qty,
       packed_section_qty = s.packed_section_qty,
       packed_piece_qty = s.packed_piece_qty,
       confirmed = s.confirmed,
       confirmed_at = s.confirmed_at,
       loaded_qty = s.loaded_qty,
       loaded_uom = s.loaded_uom,
       netsuite_active = s.netsuite_active,
       sync_exception = s.sync_exception,
       synced_at = s.synced_at
  FROM sales_order_lines s
 WHERE d.id = s.id
   AND d.order_id = s.sales_order_id;
