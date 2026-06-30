ALTER TABLE sales_order_lines
  ADD COLUMN IF NOT EXISTS sync_exception_at timestamptz;

ALTER TABLE transfer_order_lines
  ADD COLUMN IF NOT EXISTS sync_exception_at timestamptz;

UPDATE sales_order_lines s
   SET sync_exception_at = d.sync_exception_at
  FROM delivery_order_lines d
 WHERE s.sales_order_id = d.order_id
   AND s.id = d.id
   AND s.sync_exception_at IS NULL;

UPDATE transfer_order_lines t
   SET sync_exception_at = d.sync_exception_at
  FROM delivery_order_lines d
 WHERE t.line_stage = 'outbound'
   AND t.transfer_order_id = d.order_id
   AND t.id = d.id
   AND t.sync_exception_at IS NULL;

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
         sync_exception_at = NEW.sync_exception_at,
         synced_at = NEW.synced_at
   WHERE id = NEW.id
     AND order_id = NEW.sales_order_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mbbs_transfer_line_operator_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.line_stage <> 'outbound' THEN
    RETURN NEW;
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
         sync_exception_at = NEW.sync_exception_at,
         synced_at = NEW.synced_at
   WHERE id = NEW.id
     AND order_id = NEW.transfer_order_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

UPDATE delivery_order_lines d
   SET sync_exception_at = s.sync_exception_at
  FROM sales_order_lines s
 WHERE d.id = s.id
   AND d.order_id = s.sales_order_id;

UPDATE delivery_order_lines d
   SET sync_exception_at = t.sync_exception_at
  FROM transfer_order_lines t
 WHERE t.line_stage = 'outbound'
   AND d.id = t.id
   AND d.order_id = t.transfer_order_id;
