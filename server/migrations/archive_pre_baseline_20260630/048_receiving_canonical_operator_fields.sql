ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS last_item_receipt_id bigint,
  ADD COLUMN IF NOT EXISTS last_item_receipt_tranid text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz;

ALTER TABLE transfer_orders
  ADD COLUMN IF NOT EXISTS last_item_receipt_id bigint,
  ADD COLUMN IF NOT EXISTS last_item_receipt_tranid text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz;

ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS sync_exception_at timestamptz,
  ADD COLUMN IF NOT EXISTS raw jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by text;

ALTER TABLE transfer_order_lines
  ADD COLUMN IF NOT EXISTS sync_exception_at timestamptz,
  ADD COLUMN IF NOT EXISTS raw jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by text;

UPDATE purchase_orders p
   SET last_item_receipt_id = r.last_item_receipt_id,
       last_item_receipt_tranid = r.last_item_receipt_tranid,
       received_at = r.received_at
  FROM receiving_orders r
 WHERE r.netsuite_id = p.netsuite_id
   AND r.order_type = 'purchase_order';

UPDATE transfer_orders t
   SET last_item_receipt_id = r.last_item_receipt_id,
       last_item_receipt_tranid = r.last_item_receipt_tranid,
       received_at = r.received_at
  FROM receiving_orders r
 WHERE r.netsuite_id = t.netsuite_id
   AND r.order_type = 'transfer_order';

UPDATE purchase_order_lines p
   SET sync_exception_at = r.sync_exception_at,
       raw = r.raw,
       confirmed_at = r.confirmed_at,
       confirmed_by = r.confirmed_by
  FROM receiving_order_lines r
 WHERE r.id = p.id;

UPDATE transfer_order_lines t
   SET sync_exception_at = r.sync_exception_at,
       raw = r.raw,
       confirmed_at = r.confirmed_at,
       confirmed_by = r.confirmed_by
  FROM receiving_order_lines r
 WHERE r.id = t.id
   AND t.line_stage = 'receiving';

CREATE OR REPLACE FUNCTION mbbs_purchase_order_receiving_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE receiving_orders
     SET receipt_status = NEW.receipt_status,
         last_item_receipt_id = NEW.last_item_receipt_id,
         last_item_receipt_tranid = NEW.last_item_receipt_tranid,
         received_at = NEW.received_at,
         expected_delivery_date = NEW.expected_delivery_date,
         dispatch_vendor_yard = NEW.dispatch_vendor_yard,
         dispatch_address = NEW.dispatch_address,
         dispatch_window_start = NEW.dispatch_window_start,
         dispatch_window_end = NEW.dispatch_window_end,
         dispatch_instructions = NEW.dispatch_instructions,
         dispatch_parse_source = NEW.dispatch_parse_source,
         dispatch_note_hash = NEW.dispatch_note_hash,
         dispatch_parsed_at = NEW.dispatch_parsed_at
   WHERE netsuite_id = NEW.netsuite_id
     AND order_type = 'purchase_order';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mbbs_transfer_order_receiving_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE receiving_orders
     SET receipt_status = NEW.receiving_status,
         last_item_receipt_id = NEW.last_item_receipt_id,
         last_item_receipt_tranid = NEW.last_item_receipt_tranid,
         received_at = NEW.received_at,
         expected_delivery_date = NEW.expected_delivery_date,
         dispatch_address = NEW.dispatch_address,
         dispatch_window_start = NEW.dispatch_window_start,
         dispatch_window_end = NEW.dispatch_window_end,
         dispatch_instructions = NEW.dispatch_instructions,
         dispatch_parse_source = NEW.dispatch_parse_source,
         dispatch_note_hash = NEW.dispatch_note_hash,
         dispatch_parsed_at = NEW.dispatch_parsed_at
   WHERE netsuite_id = NEW.netsuite_id
     AND order_type = 'transfer_order';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mbbs_purchase_line_receiving_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE receiving_order_lines
     SET received_pallet_qty = NEW.received_pallet_qty,
         received_layer_qty = NEW.received_layer_qty,
         received_section_qty = NEW.received_section_qty,
         received_piece_qty = NEW.received_piece_qty,
         sync_exception = NEW.sync_exception,
         sync_exception_at = NEW.sync_exception_at,
         confirmed_at = NEW.confirmed_at,
         confirmed_by = NEW.confirmed_by,
         synced_at = NEW.synced_at
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mbbs_transfer_line_receiving_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.line_stage = 'receiving' THEN
    UPDATE receiving_order_lines
       SET received_pallet_qty = NEW.received_pallet_qty,
           received_layer_qty = NEW.received_layer_qty,
           received_section_qty = NEW.received_section_qty,
           received_piece_qty = NEW.received_piece_qty,
           sync_exception = NEW.sync_exception,
           sync_exception_at = NEW.sync_exception_at,
           confirmed_at = NEW.confirmed_at,
           confirmed_by = NEW.confirmed_by,
           synced_at = NEW.synced_at
     WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mbbs_co_receiving_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE local_co_orders
     SET status = NEW.status,
         received_by = NEW.received_by,
         received_at = NEW.received_at,
         updated_at = NEW.updated_at,
         loaded_at = NEW.loaded_at,
         details = NEW.details
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mbbs_co_line_receiving_legacy_trigger()
RETURNS trigger AS $$
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
         confirmed_at = NEW.confirmed_at,
         confirmed_by = NEW.confirmed_by
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_purchase_orders_receiving_legacy ON purchase_orders;
CREATE TRIGGER trg_purchase_orders_receiving_legacy
AFTER UPDATE ON purchase_orders
FOR EACH ROW
EXECUTE FUNCTION mbbs_purchase_order_receiving_legacy_trigger();

DROP TRIGGER IF EXISTS trg_transfer_orders_receiving_legacy ON transfer_orders;
CREATE TRIGGER trg_transfer_orders_receiving_legacy
AFTER UPDATE ON transfer_orders
FOR EACH ROW
EXECUTE FUNCTION mbbs_transfer_order_receiving_legacy_trigger();

DROP TRIGGER IF EXISTS trg_purchase_lines_receiving_legacy ON purchase_order_lines;
CREATE TRIGGER trg_purchase_lines_receiving_legacy
AFTER UPDATE ON purchase_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_purchase_line_receiving_legacy_trigger();

DROP TRIGGER IF EXISTS trg_transfer_lines_receiving_legacy ON transfer_order_lines;
CREATE TRIGGER trg_transfer_lines_receiving_legacy
AFTER UPDATE ON transfer_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_transfer_line_receiving_legacy_trigger();

DROP TRIGGER IF EXISTS trg_co_orders_receiving_legacy ON co_orders;
CREATE TRIGGER trg_co_orders_receiving_legacy
AFTER UPDATE ON co_orders
FOR EACH ROW
EXECUTE FUNCTION mbbs_co_receiving_legacy_trigger();

DROP TRIGGER IF EXISTS trg_co_lines_receiving_legacy ON co_order_lines;
CREATE TRIGGER trg_co_lines_receiving_legacy
AFTER UPDATE ON co_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_co_line_receiving_legacy_trigger();
