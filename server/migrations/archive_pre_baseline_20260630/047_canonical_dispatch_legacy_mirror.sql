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
         dispatch_planned = NEW.dispatch_planned,
         dispatch_plan_date = NEW.dispatch_plan_date,
         dispatch_truck_plate = NEW.dispatch_truck_plate,
         dispatch_load_name = NEW.dispatch_load_name,
         dispatch_parking_spot = NEW.dispatch_parking_spot,
         dispatch_planned_at = NEW.dispatch_planned_at
   WHERE netsuite_id = NEW.netsuite_id
     AND order_type = 'sales_order';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mbbs_purchase_order_dispatch_legacy_trigger()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE receiving_orders
     SET expected_delivery_date = NEW.expected_delivery_date,
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
         fulfillment_status = NEW.fulfillment_status,
         dispatch_planned = NEW.dispatch_planned,
         dispatch_plan_date = NEW.dispatch_plan_date,
         dispatch_truck_plate = NEW.dispatch_truck_plate,
         dispatch_load_name = NEW.dispatch_load_name,
         dispatch_parking_spot = NEW.dispatch_parking_spot,
         dispatch_planned_at = NEW.dispatch_planned_at
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

DROP TRIGGER IF EXISTS trg_sales_orders_dispatch_legacy ON sales_orders;
CREATE TRIGGER trg_sales_orders_dispatch_legacy
AFTER UPDATE ON sales_orders
FOR EACH ROW
EXECUTE FUNCTION mbbs_sales_order_dispatch_legacy_trigger();

DROP TRIGGER IF EXISTS trg_purchase_orders_dispatch_legacy ON purchase_orders;
CREATE TRIGGER trg_purchase_orders_dispatch_legacy
AFTER UPDATE ON purchase_orders
FOR EACH ROW
EXECUTE FUNCTION mbbs_purchase_order_dispatch_legacy_trigger();

DROP TRIGGER IF EXISTS trg_transfer_orders_dispatch_legacy ON transfer_orders;
CREATE TRIGGER trg_transfer_orders_dispatch_legacy
AFTER UPDATE ON transfer_orders
FOR EACH ROW
EXECUTE FUNCTION mbbs_transfer_order_dispatch_legacy_trigger();

UPDATE delivery_orders d
   SET expected_delivery_date = s.expected_delivery_date,
       dispatch_address = s.dispatch_address,
       dispatch_window_start = s.dispatch_window_start,
       dispatch_window_end = s.dispatch_window_end,
       dispatch_instructions = s.dispatch_instructions,
       dispatch_parse_source = s.dispatch_parse_source,
       dispatch_note_hash = s.dispatch_note_hash,
       dispatch_parsed_at = s.dispatch_parsed_at,
       operator_status = s.operator_status,
       local_yard_order_status = s.local_yard_order_status,
       dispatch_planned = s.dispatch_planned,
       dispatch_plan_date = s.dispatch_plan_date,
       dispatch_truck_plate = s.dispatch_truck_plate,
       dispatch_load_name = s.dispatch_load_name,
       dispatch_parking_spot = s.dispatch_parking_spot,
       dispatch_planned_at = s.dispatch_planned_at
  FROM sales_orders s
 WHERE d.netsuite_id = s.netsuite_id
   AND d.order_type = 'sales_order';

UPDATE receiving_orders r
   SET expected_delivery_date = p.expected_delivery_date,
       dispatch_vendor_yard = p.dispatch_vendor_yard,
       dispatch_address = p.dispatch_address,
       dispatch_window_start = p.dispatch_window_start,
       dispatch_window_end = p.dispatch_window_end,
       dispatch_instructions = p.dispatch_instructions,
       dispatch_parse_source = p.dispatch_parse_source,
       dispatch_note_hash = p.dispatch_note_hash,
       dispatch_parsed_at = p.dispatch_parsed_at
  FROM purchase_orders p
 WHERE r.netsuite_id = p.netsuite_id
   AND r.order_type = 'purchase_order';

UPDATE delivery_orders d
   SET expected_delivery_date = t.expected_delivery_date,
       dispatch_address = t.dispatch_address,
       dispatch_window_start = t.dispatch_window_start,
       dispatch_window_end = t.dispatch_window_end,
       dispatch_instructions = t.dispatch_instructions,
       dispatch_parse_source = t.dispatch_parse_source,
       dispatch_note_hash = t.dispatch_note_hash,
       dispatch_parsed_at = t.dispatch_parsed_at,
       operator_status = t.outbound_operator_status,
       local_yard_order_status = t.local_yard_order_status,
       fulfillment_status = t.fulfillment_status,
       dispatch_planned = t.dispatch_planned,
       dispatch_plan_date = t.dispatch_plan_date,
       dispatch_truck_plate = t.dispatch_truck_plate,
       dispatch_load_name = t.dispatch_load_name,
       dispatch_parking_spot = t.dispatch_parking_spot,
       dispatch_planned_at = t.dispatch_planned_at
  FROM transfer_orders t
 WHERE d.netsuite_id = t.netsuite_id
   AND d.order_type = 'transfer_order';

UPDATE receiving_orders r
   SET expected_delivery_date = t.expected_delivery_date,
       dispatch_address = t.dispatch_address,
       dispatch_window_start = t.dispatch_window_start,
       dispatch_window_end = t.dispatch_window_end,
       dispatch_instructions = t.dispatch_instructions,
       dispatch_parse_source = t.dispatch_parse_source,
       dispatch_note_hash = t.dispatch_note_hash,
       dispatch_parsed_at = t.dispatch_parsed_at,
       receipt_status = t.receiving_status
  FROM transfer_orders t
 WHERE r.netsuite_id = t.netsuite_id
   AND r.order_type = 'transfer_order';
