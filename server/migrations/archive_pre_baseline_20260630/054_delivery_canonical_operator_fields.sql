ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS preparing_operator_id text,
  ADD COLUMN IF NOT EXISTS preparing_started_at timestamptz;

ALTER TABLE transfer_orders
  ADD COLUMN IF NOT EXISTS preparing_operator_id text,
  ADD COLUMN IF NOT EXISTS preparing_started_at timestamptz;

ALTER TABLE transfer_order_lines
  ADD COLUMN IF NOT EXISTS confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

UPDATE sales_orders s
   SET preparing_operator_id = d.preparing_operator_id,
       preparing_started_at = d.preparing_started_at
  FROM delivery_orders d
 WHERE d.netsuite_id = s.netsuite_id
   AND d.order_type = 'sales_order'
   AND (s.preparing_operator_id IS NULL OR s.preparing_started_at IS NULL);

UPDATE transfer_orders t
   SET preparing_operator_id = d.preparing_operator_id,
       preparing_started_at = d.preparing_started_at
  FROM delivery_orders d
 WHERE d.netsuite_id = t.netsuite_id
   AND d.order_type = 'transfer_order'
   AND (t.preparing_operator_id IS NULL OR t.preparing_started_at IS NULL);

UPDATE transfer_order_lines t
   SET confirmed = d.confirmed,
       confirmed_at = d.confirmed_at
  FROM delivery_order_lines d
 WHERE t.line_stage = 'outbound'
   AND t.id = d.id
   AND t.transfer_order_id = d.order_id;

CREATE OR REPLACE FUNCTION mbbs_rebuild_sales_order(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM sales_orders WHERE netsuite_id = p_order_id;

  INSERT INTO sales_orders (
    netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
    foreign_total, order_location_id, order_location, outbound_location_id,
    outbound_location, delivery_method_id, sales_order_type, memo,
    expected_delivery_date, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, operator_status,
    local_yard_order_status, preparing_operator_id, preparing_started_at,
    netsuite_active, synced_at, dispatch_parse_source, dispatch_note_hash,
    dispatch_parsed_at, fulfillment_status, dispatch_planned,
    dispatch_plan_date, dispatch_truck_plate, dispatch_load_name,
    dispatch_parking_spot, dispatch_planned_at, netsuite_missing_at,
    status_updated_at
  )
  SELECT
    netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
    foreign_total, order_location_id, order_location, outbound_location_id,
    outbound_location, delivery_method_id, delivery_method, memo,
    expected_delivery_date, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, operator_status,
    local_yard_order_status, preparing_operator_id, preparing_started_at,
    netsuite_active, synced_at, dispatch_parse_source, dispatch_note_hash,
    dispatch_parsed_at, fulfillment_status, dispatch_planned,
    dispatch_plan_date, dispatch_truck_plate, dispatch_load_name,
    dispatch_parking_spot, dispatch_planned_at, netsuite_missing_at,
    status_updated_at
  FROM delivery_orders
  WHERE netsuite_id = p_order_id
    AND order_type = 'sales_order';
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_transfer_order(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM transfer_orders WHERE netsuite_id = p_order_id;

  INSERT INTO transfer_orders (
    netsuite_id, tranid, trandate, status, status_text, from_location_id,
    from_location, to_location_id, to_location, outbound_operator_status,
    receiving_status, netsuite_active, synced_at, memo, expected_delivery_date,
    dispatch_address, dispatch_window_start, dispatch_window_end,
    dispatch_instructions, dispatch_parse_source, dispatch_note_hash,
    dispatch_parsed_at, local_yard_order_status, preparing_operator_id,
    preparing_started_at, fulfillment_status, dispatch_planned,
    dispatch_plan_date, dispatch_truck_plate, dispatch_load_name,
    dispatch_parking_spot, dispatch_planned_at, netsuite_missing_at,
    last_item_receipt_id, last_item_receipt_tranid, received_at,
    status_updated_at
  )
  SELECT
    COALESCE(d.netsuite_id, r.netsuite_id) AS netsuite_id,
    COALESCE(d.tranid, r.tranid) AS tranid,
    COALESCE(d.trandate, r.trandate) AS trandate,
    COALESCE(d.status, r.status) AS status,
    COALESCE(d.status_text, r.status_text) AS status_text,
    COALESCE(d.source_location_id, r.source_location_id, d.outbound_location_id) AS from_location_id,
    COALESCE(d.source_location, r.source_location, d.outbound_location) AS from_location,
    COALESCE(d.destination_location_id, r.destination_location_id) AS to_location_id,
    COALESCE(d.destination_location, r.destination_location) AS to_location,
    d.operator_status AS outbound_operator_status,
    r.receipt_status AS receiving_status,
    COALESCE(d.netsuite_active, r.netsuite_active, true) AS netsuite_active,
    GREATEST(COALESCE(d.synced_at, '-infinity'::timestamptz), COALESCE(r.synced_at, '-infinity'::timestamptz)) AS synced_at,
    COALESCE(d.memo, r.memo) AS memo,
    COALESCE(d.expected_delivery_date, r.expected_delivery_date) AS expected_delivery_date,
    COALESCE(d.dispatch_address, r.dispatch_address) AS dispatch_address,
    COALESCE(d.dispatch_window_start, r.dispatch_window_start) AS dispatch_window_start,
    COALESCE(d.dispatch_window_end, r.dispatch_window_end) AS dispatch_window_end,
    COALESCE(d.dispatch_instructions, r.dispatch_instructions) AS dispatch_instructions,
    COALESCE(d.dispatch_parse_source, r.dispatch_parse_source) AS dispatch_parse_source,
    COALESCE(d.dispatch_note_hash, r.dispatch_note_hash) AS dispatch_note_hash,
    GREATEST(COALESCE(d.dispatch_parsed_at, '-infinity'::timestamptz), COALESCE(r.dispatch_parsed_at, '-infinity'::timestamptz)) AS dispatch_parsed_at,
    d.local_yard_order_status,
    d.preparing_operator_id,
    d.preparing_started_at,
    d.fulfillment_status,
    d.dispatch_planned,
    d.dispatch_plan_date,
    d.dispatch_truck_plate,
    d.dispatch_load_name,
    d.dispatch_parking_spot,
    d.dispatch_planned_at,
    COALESCE(d.netsuite_missing_at, r.netsuite_missing_at) AS netsuite_missing_at,
    r.last_item_receipt_id,
    r.last_item_receipt_tranid,
    r.received_at,
    GREATEST(COALESCE(d.status_updated_at, '-infinity'::timestamptz), COALESCE(r.synced_at, '-infinity'::timestamptz)) AS status_updated_at
  FROM (SELECT * FROM delivery_orders WHERE order_type = 'transfer_order' AND netsuite_id = p_order_id) d
  FULL JOIN (SELECT * FROM receiving_orders WHERE order_type = 'transfer_order' AND netsuite_id = p_order_id) r
    ON r.netsuite_id = d.netsuite_id
  WHERE COALESCE(d.netsuite_id, r.netsuite_id) IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_sales_order_dispatch_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE delivery_orders
     SET expected_delivery_date = NEW.expected_delivery_date,
         dispatch_address = NEW.dispatch_address,
         dispatch_window_start = NEW.dispatch_window_start,
         dispatch_window_end = NEW.dispatch_window_end,
         dispatch_instructions = NEW.dispatch_instructions,
         dispatch_parse_source = NEW.dispatch_parse_source,
         dispatch_note_hash = NEW.dispatch_note_hash,
         dispatch_parsed_at = NEW.dispatch_parsed_at,
         operator_status = NEW.operator_status,
         local_yard_order_status = NEW.local_yard_order_status,
         preparing_operator_id = NEW.preparing_operator_id,
         preparing_started_at = NEW.preparing_started_at,
         dispatch_planned = NEW.dispatch_planned,
         dispatch_plan_date = NEW.dispatch_plan_date,
         dispatch_truck_plate = NEW.dispatch_truck_plate,
         dispatch_load_name = NEW.dispatch_load_name,
         dispatch_parking_spot = NEW.dispatch_parking_spot,
         dispatch_planned_at = NEW.dispatch_planned_at,
         status_updated_at = NEW.status_updated_at
   WHERE netsuite_id = NEW.netsuite_id
     AND order_type = 'sales_order';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mbbs_transfer_order_dispatch_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE delivery_orders
     SET expected_delivery_date = NEW.expected_delivery_date,
         dispatch_address = NEW.dispatch_address,
         dispatch_window_start = NEW.dispatch_window_start,
         dispatch_window_end = NEW.dispatch_window_end,
         dispatch_instructions = NEW.dispatch_instructions,
         dispatch_parse_source = NEW.dispatch_parse_source,
         dispatch_note_hash = NEW.dispatch_note_hash,
         dispatch_parsed_at = NEW.dispatch_parsed_at,
         operator_status = NEW.outbound_operator_status,
         local_yard_order_status = NEW.local_yard_order_status,
         preparing_operator_id = NEW.preparing_operator_id,
         preparing_started_at = NEW.preparing_started_at,
         fulfillment_status = NEW.fulfillment_status,
         dispatch_planned = NEW.dispatch_planned,
         dispatch_plan_date = NEW.dispatch_plan_date,
         dispatch_truck_plate = NEW.dispatch_truck_plate,
         dispatch_load_name = NEW.dispatch_load_name,
         dispatch_parking_spot = NEW.dispatch_parking_spot,
         dispatch_planned_at = NEW.dispatch_planned_at,
         status_updated_at = NEW.status_updated_at
   WHERE netsuite_id = NEW.netsuite_id
     AND order_type = 'transfer_order';

  UPDATE receiving_orders
     SET expected_delivery_date = NEW.expected_delivery_date,
         dispatch_address = NEW.dispatch_address,
         dispatch_window_start = NEW.dispatch_window_start,
         dispatch_window_end = NEW.dispatch_window_end,
         dispatch_instructions = NEW.dispatch_instructions,
         dispatch_parse_source = NEW.dispatch_parse_source,
         dispatch_note_hash = NEW.dispatch_note_hash,
         dispatch_parsed_at = NEW.dispatch_parsed_at,
         receipt_status = NEW.receiving_status
   WHERE netsuite_id = NEW.netsuite_id
     AND order_type = 'transfer_order';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
         synced_at = NEW.synced_at
   WHERE id = NEW.id
     AND order_id = NEW.transfer_order_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sales_lines_operator_legacy ON sales_order_lines;
CREATE TRIGGER trg_sales_lines_operator_legacy
AFTER UPDATE ON sales_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_sales_line_operator_legacy_trigger();

DROP TRIGGER IF EXISTS trg_transfer_lines_operator_legacy ON transfer_order_lines;
CREATE TRIGGER trg_transfer_lines_operator_legacy
AFTER UPDATE ON transfer_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_transfer_line_operator_legacy_trigger();

UPDATE delivery_orders d
   SET preparing_operator_id = s.preparing_operator_id,
       preparing_started_at = s.preparing_started_at
  FROM sales_orders s
 WHERE d.netsuite_id = s.netsuite_id
   AND d.order_type = 'sales_order';

UPDATE delivery_orders d
   SET preparing_operator_id = t.preparing_operator_id,
       preparing_started_at = t.preparing_started_at
  FROM transfer_orders t
 WHERE d.netsuite_id = t.netsuite_id
   AND d.order_type = 'transfer_order';

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

UPDATE delivery_order_lines d
   SET packed_pallet_qty = t.packed_pallet_qty,
       packed_layer_qty = t.packed_layer_qty,
       packed_section_qty = t.packed_section_qty,
       packed_piece_qty = t.packed_piece_qty,
       confirmed = t.confirmed,
       confirmed_at = t.confirmed_at,
       loaded_qty = t.loaded_qty,
       loaded_uom = t.loaded_uom,
       netsuite_active = t.netsuite_active,
       sync_exception = t.sync_exception,
       synced_at = t.synced_at
  FROM transfer_order_lines t
 WHERE t.line_stage = 'outbound'
   AND d.id = t.id
   AND d.order_id = t.transfer_order_id;
