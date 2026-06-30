ALTER TABLE sales_order_lines
  ALTER COLUMN id SET DEFAULT nextval('delivery_order_lines_id_seq');

ALTER TABLE transfer_order_lines
  ALTER COLUMN id SET DEFAULT nextval('delivery_order_lines_id_seq');

ALTER TABLE purchase_order_lines
  ALTER COLUMN id SET DEFAULT nextval('receiving_order_lines_id_seq');

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_order_lines_order_stage_line_unique
  ON transfer_order_lines (transfer_order_id, line_stage, line_id)
  WHERE line_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbbs_delivery_order_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_id bigint := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.netsuite_id END;
  v_new_id bigint := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.netsuite_id END;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF v_old_id IS NOT NULL THEN
    PERFORM mbbs_rebuild_sales_order(v_old_id);
    PERFORM mbbs_rebuild_sales_order_lines(v_old_id);
    PERFORM mbbs_rebuild_transfer_order(v_old_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_old_id, 'outbound');
  END IF;
  IF v_new_id IS NOT NULL AND v_new_id IS DISTINCT FROM v_old_id THEN
    PERFORM mbbs_rebuild_sales_order(v_new_id);
    PERFORM mbbs_rebuild_sales_order_lines(v_new_id);
    PERFORM mbbs_rebuild_transfer_order(v_new_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_new_id, 'outbound');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_delivery_line_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_id bigint := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.order_id END;
  v_new_id bigint := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.order_id END;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF v_old_id IS NOT NULL THEN
    PERFORM mbbs_rebuild_sales_order_lines(v_old_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_old_id, 'outbound');
  END IF;
  IF v_new_id IS NOT NULL AND v_new_id IS DISTINCT FROM v_old_id THEN
    PERFORM mbbs_rebuild_sales_order_lines(v_new_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_new_id, 'outbound');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_receiving_order_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_id bigint := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.netsuite_id END;
  v_new_id bigint := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.netsuite_id END;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF v_old_id IS NOT NULL THEN
    PERFORM mbbs_rebuild_purchase_order(v_old_id);
    PERFORM mbbs_rebuild_purchase_order_lines(v_old_id);
    PERFORM mbbs_rebuild_transfer_order(v_old_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_old_id, 'receiving');
  END IF;
  IF v_new_id IS NOT NULL AND v_new_id IS DISTINCT FROM v_old_id THEN
    PERFORM mbbs_rebuild_purchase_order(v_new_id);
    PERFORM mbbs_rebuild_purchase_order_lines(v_new_id);
    PERFORM mbbs_rebuild_transfer_order(v_new_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_new_id, 'receiving');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_receiving_line_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_id bigint := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.order_id END;
  v_new_id bigint := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.order_id END;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF v_old_id IS NOT NULL THEN
    PERFORM mbbs_rebuild_purchase_order_lines(v_old_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_old_id, 'receiving');
  END IF;
  IF v_new_id IS NOT NULL AND v_new_id IS DISTINCT FROM v_old_id THEN
    PERFORM mbbs_rebuild_purchase_order_lines(v_new_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_new_id, 'receiving');
  END IF;
  RETURN COALESCE(NEW, OLD);
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

  INSERT INTO delivery_orders (
    netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
    foreign_total, order_location_id, order_location, outbound_location_id,
    outbound_location, delivery_method_id, delivery_method, order_type, memo,
    expected_delivery_date, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, dispatch_parse_source,
    dispatch_note_hash, dispatch_parsed_at, operator_status,
    local_yard_order_status, preparing_operator_id, preparing_started_at,
    netsuite_active, netsuite_missing_at, synced_at, fulfillment_status,
    dispatch_planned, dispatch_plan_date, dispatch_truck_plate,
    dispatch_load_name, dispatch_parking_spot, dispatch_planned_at,
    status_updated_at, prepared, prepared_at
  ) VALUES (
    NEW.netsuite_id, COALESCE(NEW.tranid, ''), NEW.trandate, NEW.customer_id,
    NEW.customer, NEW.status, NEW.status_text, NEW.foreign_total,
    NEW.order_location_id, NEW.order_location, NEW.outbound_location_id,
    NEW.outbound_location, NEW.delivery_method_id, NEW.sales_order_type,
    'sales_order', NEW.memo, NEW.expected_delivery_date, NEW.dispatch_address,
    NEW.dispatch_window_start, NEW.dispatch_window_end, NEW.dispatch_instructions,
    NEW.dispatch_parse_source, NEW.dispatch_note_hash, NEW.dispatch_parsed_at,
    COALESCE(NEW.operator_status, 'open'), COALESCE(NEW.local_yard_order_status, 'Open'),
    NEW.preparing_operator_id, NEW.preparing_started_at,
    COALESCE(NEW.netsuite_active, true), NEW.netsuite_missing_at, COALESCE(NEW.synced_at, now()),
    COALESCE(NEW.fulfillment_status, 'not_fulfilled'), COALESCE(NEW.dispatch_planned, false),
    NEW.dispatch_plan_date, NEW.dispatch_truck_plate, NEW.dispatch_load_name,
    NEW.dispatch_parking_spot, NEW.dispatch_planned_at, NEW.status_updated_at,
    COALESCE(NEW.operator_status, 'open') IN ('packed', 'loaded', 'fulfilled'),
    CASE WHEN COALESCE(NEW.operator_status, 'open') IN ('packed', 'loaded', 'fulfilled') THEN now() ELSE null END
  )
  ON CONFLICT (netsuite_id) DO UPDATE SET
    tranid = EXCLUDED.tranid,
    trandate = EXCLUDED.trandate,
    customer_id = EXCLUDED.customer_id,
    customer = EXCLUDED.customer,
    status = EXCLUDED.status,
    status_text = EXCLUDED.status_text,
    foreign_total = EXCLUDED.foreign_total,
    order_location_id = EXCLUDED.order_location_id,
    order_location = EXCLUDED.order_location,
    outbound_location_id = EXCLUDED.outbound_location_id,
    outbound_location = EXCLUDED.outbound_location,
    delivery_method_id = EXCLUDED.delivery_method_id,
    delivery_method = EXCLUDED.delivery_method,
    order_type = EXCLUDED.order_type,
    memo = EXCLUDED.memo,
    expected_delivery_date = EXCLUDED.expected_delivery_date,
    dispatch_address = EXCLUDED.dispatch_address,
    dispatch_window_start = EXCLUDED.dispatch_window_start,
    dispatch_window_end = EXCLUDED.dispatch_window_end,
    dispatch_instructions = EXCLUDED.dispatch_instructions,
    dispatch_parse_source = EXCLUDED.dispatch_parse_source,
    dispatch_note_hash = EXCLUDED.dispatch_note_hash,
    dispatch_parsed_at = EXCLUDED.dispatch_parsed_at,
    operator_status = EXCLUDED.operator_status,
    local_yard_order_status = EXCLUDED.local_yard_order_status,
    preparing_operator_id = EXCLUDED.preparing_operator_id,
    preparing_started_at = EXCLUDED.preparing_started_at,
    netsuite_active = EXCLUDED.netsuite_active,
    netsuite_missing_at = EXCLUDED.netsuite_missing_at,
    synced_at = EXCLUDED.synced_at,
    fulfillment_status = EXCLUDED.fulfillment_status,
    dispatch_planned = EXCLUDED.dispatch_planned,
    dispatch_plan_date = EXCLUDED.dispatch_plan_date,
    dispatch_truck_plate = EXCLUDED.dispatch_truck_plate,
    dispatch_load_name = EXCLUDED.dispatch_load_name,
    dispatch_parking_spot = EXCLUDED.dispatch_parking_spot,
    dispatch_planned_at = EXCLUDED.dispatch_planned_at,
    status_updated_at = EXCLUDED.status_updated_at,
    prepared = EXCLUDED.prepared,
    prepared_at = CASE WHEN EXCLUDED.prepared THEN COALESCE(delivery_orders.prepared_at, now()) ELSE null END;

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

  INSERT INTO receiving_orders (
    netsuite_id, order_type, tranid, trandate, vendor_id, vendor, status,
    status_text, foreign_total, source_location_id, source_location,
    destination_location_id, destination_location, memo, expected_delivery_date,
    dispatch_vendor_yard, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, dispatch_parse_source,
    dispatch_note_hash, dispatch_parsed_at, receipt_status,
    last_item_receipt_id, last_item_receipt_tranid, received_at,
    netsuite_active, netsuite_missing_at, synced_at
  ) VALUES (
    NEW.netsuite_id, 'purchase_order', COALESCE(NEW.tranid, ''), NEW.trandate,
    NEW.vendor_id, NEW.vendor, NEW.status, NEW.status_text, NEW.foreign_total,
    NEW.source_location_id, NEW.source_location, NEW.destination_location_id,
    NEW.destination_location, NEW.memo, NEW.expected_delivery_date,
    NEW.dispatch_vendor_yard, NEW.dispatch_address, NEW.dispatch_window_start,
    NEW.dispatch_window_end, NEW.dispatch_instructions, NEW.dispatch_parse_source,
    NEW.dispatch_note_hash, NEW.dispatch_parsed_at, COALESCE(NEW.receipt_status, 'not_received'),
    NEW.last_item_receipt_id, NEW.last_item_receipt_tranid, NEW.received_at,
    COALESCE(NEW.netsuite_active, true), NEW.netsuite_missing_at, COALESCE(NEW.synced_at, now())
  )
  ON CONFLICT (netsuite_id) DO UPDATE SET
    order_type = EXCLUDED.order_type,
    tranid = EXCLUDED.tranid,
    trandate = EXCLUDED.trandate,
    vendor_id = EXCLUDED.vendor_id,
    vendor = EXCLUDED.vendor,
    status = EXCLUDED.status,
    status_text = EXCLUDED.status_text,
    foreign_total = EXCLUDED.foreign_total,
    source_location_id = EXCLUDED.source_location_id,
    source_location = EXCLUDED.source_location,
    destination_location_id = EXCLUDED.destination_location_id,
    destination_location = EXCLUDED.destination_location,
    memo = EXCLUDED.memo,
    expected_delivery_date = EXCLUDED.expected_delivery_date,
    dispatch_vendor_yard = EXCLUDED.dispatch_vendor_yard,
    dispatch_address = EXCLUDED.dispatch_address,
    dispatch_window_start = EXCLUDED.dispatch_window_start,
    dispatch_window_end = EXCLUDED.dispatch_window_end,
    dispatch_instructions = EXCLUDED.dispatch_instructions,
    dispatch_parse_source = EXCLUDED.dispatch_parse_source,
    dispatch_note_hash = EXCLUDED.dispatch_note_hash,
    dispatch_parsed_at = EXCLUDED.dispatch_parsed_at,
    receipt_status = EXCLUDED.receipt_status,
    last_item_receipt_id = EXCLUDED.last_item_receipt_id,
    last_item_receipt_tranid = EXCLUDED.last_item_receipt_tranid,
    received_at = EXCLUDED.received_at,
    netsuite_active = EXCLUDED.netsuite_active,
    netsuite_missing_at = EXCLUDED.netsuite_missing_at,
    synced_at = EXCLUDED.synced_at;

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

  IF NEW.outbound_operator_status IS NOT NULL
     OR EXISTS (SELECT 1 FROM delivery_orders WHERE netsuite_id = NEW.netsuite_id AND order_type = 'transfer_order') THEN
    INSERT INTO delivery_orders (
      netsuite_id, tranid, trandate, status, status_text, outbound_location_id,
      outbound_location, order_type, source_location_id, source_location,
      destination_location_id, destination_location, delivery_method, memo,
      expected_delivery_date, dispatch_address, dispatch_window_start,
      dispatch_window_end, dispatch_instructions, dispatch_parse_source,
      dispatch_note_hash, dispatch_parsed_at, operator_status,
      local_yard_order_status, preparing_operator_id, preparing_started_at,
      fulfillment_status, netsuite_active, netsuite_missing_at, synced_at,
      dispatch_planned, dispatch_plan_date, dispatch_truck_plate,
      dispatch_load_name, dispatch_parking_spot, dispatch_planned_at,
      status_updated_at, prepared, prepared_at
    ) VALUES (
      NEW.netsuite_id, COALESCE(NEW.tranid, ''), NEW.trandate, NEW.status,
      NEW.status_text, NEW.from_location_id, NEW.from_location, 'transfer_order',
      NEW.from_location_id, NEW.from_location, NEW.to_location_id, NEW.to_location,
      'Transfer Order', NEW.memo, NEW.expected_delivery_date, NEW.dispatch_address,
      NEW.dispatch_window_start, NEW.dispatch_window_end, NEW.dispatch_instructions,
      NEW.dispatch_parse_source, NEW.dispatch_note_hash, NEW.dispatch_parsed_at,
      COALESCE(NEW.outbound_operator_status, 'open'), COALESCE(NEW.local_yard_order_status, 'Open'),
      NEW.preparing_operator_id, NEW.preparing_started_at,
      COALESCE(NEW.fulfillment_status, 'not_fulfilled'), COALESCE(NEW.netsuite_active, true),
      NEW.netsuite_missing_at, COALESCE(NEW.synced_at, now()), COALESCE(NEW.dispatch_planned, false),
      NEW.dispatch_plan_date, NEW.dispatch_truck_plate, NEW.dispatch_load_name,
      NEW.dispatch_parking_spot, NEW.dispatch_planned_at, NEW.status_updated_at,
      COALESCE(NEW.outbound_operator_status, 'open') IN ('packed', 'loaded', 'fulfilled'),
      CASE WHEN COALESCE(NEW.outbound_operator_status, 'open') IN ('packed', 'loaded', 'fulfilled') THEN now() ELSE null END
    )
    ON CONFLICT (netsuite_id) DO UPDATE SET
      tranid = EXCLUDED.tranid,
      trandate = EXCLUDED.trandate,
      status = EXCLUDED.status,
      status_text = EXCLUDED.status_text,
      outbound_location_id = EXCLUDED.outbound_location_id,
      outbound_location = EXCLUDED.outbound_location,
      order_type = EXCLUDED.order_type,
      source_location_id = EXCLUDED.source_location_id,
      source_location = EXCLUDED.source_location,
      destination_location_id = EXCLUDED.destination_location_id,
      destination_location = EXCLUDED.destination_location,
      delivery_method = EXCLUDED.delivery_method,
      memo = EXCLUDED.memo,
      expected_delivery_date = EXCLUDED.expected_delivery_date,
      dispatch_address = EXCLUDED.dispatch_address,
      dispatch_window_start = EXCLUDED.dispatch_window_start,
      dispatch_window_end = EXCLUDED.dispatch_window_end,
      dispatch_instructions = EXCLUDED.dispatch_instructions,
      dispatch_parse_source = EXCLUDED.dispatch_parse_source,
      dispatch_note_hash = EXCLUDED.dispatch_note_hash,
      dispatch_parsed_at = EXCLUDED.dispatch_parsed_at,
      operator_status = EXCLUDED.operator_status,
      local_yard_order_status = EXCLUDED.local_yard_order_status,
      preparing_operator_id = EXCLUDED.preparing_operator_id,
      preparing_started_at = EXCLUDED.preparing_started_at,
      fulfillment_status = EXCLUDED.fulfillment_status,
      netsuite_active = EXCLUDED.netsuite_active,
      netsuite_missing_at = EXCLUDED.netsuite_missing_at,
      synced_at = EXCLUDED.synced_at,
      dispatch_planned = EXCLUDED.dispatch_planned,
      dispatch_plan_date = EXCLUDED.dispatch_plan_date,
      dispatch_truck_plate = EXCLUDED.dispatch_truck_plate,
      dispatch_load_name = EXCLUDED.dispatch_load_name,
      dispatch_parking_spot = EXCLUDED.dispatch_parking_spot,
      dispatch_planned_at = EXCLUDED.dispatch_planned_at,
      status_updated_at = EXCLUDED.status_updated_at,
      prepared = EXCLUDED.prepared,
      prepared_at = CASE WHEN EXCLUDED.prepared THEN COALESCE(delivery_orders.prepared_at, now()) ELSE null END;
  END IF;

  IF NEW.receiving_status IS NOT NULL
     OR EXISTS (SELECT 1 FROM receiving_orders WHERE netsuite_id = NEW.netsuite_id AND order_type = 'transfer_order') THEN
    INSERT INTO receiving_orders (
      netsuite_id, order_type, tranid, trandate, vendor_id, vendor, status,
      status_text, source_location_id, source_location, destination_location_id,
      destination_location, memo, expected_delivery_date, dispatch_address,
      dispatch_window_start, dispatch_window_end, dispatch_instructions,
      dispatch_parse_source, dispatch_note_hash, dispatch_parsed_at,
      receipt_status, last_item_receipt_id, last_item_receipt_tranid,
      received_at, netsuite_active, netsuite_missing_at, synced_at
    ) VALUES (
      NEW.netsuite_id, 'transfer_order', COALESCE(NEW.tranid, ''), NEW.trandate,
      NEW.from_location_id, NEW.from_location, NEW.status, NEW.status_text,
      NEW.from_location_id, NEW.from_location, NEW.to_location_id, NEW.to_location,
      NEW.memo, NEW.expected_delivery_date, NEW.dispatch_address,
      NEW.dispatch_window_start, NEW.dispatch_window_end, NEW.dispatch_instructions,
      NEW.dispatch_parse_source, NEW.dispatch_note_hash, NEW.dispatch_parsed_at,
      COALESCE(NEW.receiving_status, 'not_received'), NEW.last_item_receipt_id,
      NEW.last_item_receipt_tranid, NEW.received_at, COALESCE(NEW.netsuite_active, true),
      NEW.netsuite_missing_at, COALESCE(NEW.synced_at, now())
    )
    ON CONFLICT (netsuite_id) DO UPDATE SET
      order_type = EXCLUDED.order_type,
      tranid = EXCLUDED.tranid,
      trandate = EXCLUDED.trandate,
      vendor_id = EXCLUDED.vendor_id,
      vendor = EXCLUDED.vendor,
      status = EXCLUDED.status,
      status_text = EXCLUDED.status_text,
      source_location_id = EXCLUDED.source_location_id,
      source_location = EXCLUDED.source_location,
      destination_location_id = EXCLUDED.destination_location_id,
      destination_location = EXCLUDED.destination_location,
      memo = EXCLUDED.memo,
      expected_delivery_date = EXCLUDED.expected_delivery_date,
      dispatch_address = EXCLUDED.dispatch_address,
      dispatch_window_start = EXCLUDED.dispatch_window_start,
      dispatch_window_end = EXCLUDED.dispatch_window_end,
      dispatch_instructions = EXCLUDED.dispatch_instructions,
      dispatch_parse_source = EXCLUDED.dispatch_parse_source,
      dispatch_note_hash = EXCLUDED.dispatch_note_hash,
      dispatch_parsed_at = EXCLUDED.dispatch_parsed_at,
      receipt_status = EXCLUDED.receipt_status,
      last_item_receipt_id = EXCLUDED.last_item_receipt_id,
      last_item_receipt_tranid = EXCLUDED.last_item_receipt_tranid,
      received_at = EXCLUDED.received_at,
      netsuite_active = EXCLUDED.netsuite_active,
      netsuite_missing_at = EXCLUDED.netsuite_missing_at,
      synced_at = EXCLUDED.synced_at;
  END IF;

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

  INSERT INTO delivery_order_lines (
    id, order_id, line_id, item_id, item_name, sku, item_description,
    item_type, item_type_text, quantity, unit, location_id, location,
    pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec,
    to_pcs, item_weight, packed_pallet_qty, packed_layer_qty,
    packed_section_qty, packed_piece_qty, confirmed, confirmed_at,
    loaded_qty, loaded_uom, netsuite_active, sync_exception,
    sync_exception_at, synced_at
  ) VALUES (
    NEW.id, NEW.sales_order_id, NEW.line_id, NEW.item_id, NEW.item_name,
    NEW.sku, NEW.item_description, NEW.item_type, NEW.item_type_text,
    NEW.quantity, NEW.unit, NEW.location_id, NEW.location, NEW.pallet_qty,
    NEW.layer_qty, NEW.piece_qty, NEW.section_qty, NEW.to_plt, NEW.to_lyr,
    NEW.to_sec, NEW.to_pcs, NEW.item_weight, COALESCE(NEW.packed_pallet_qty, 0),
    COALESCE(NEW.packed_layer_qty, 0), COALESCE(NEW.packed_section_qty, 0),
    COALESCE(NEW.packed_piece_qty, 0), COALESCE(NEW.confirmed, false),
    NEW.confirmed_at, COALESCE(NEW.loaded_qty, 0), NEW.loaded_uom,
    COALESCE(NEW.netsuite_active, true), NEW.sync_exception,
    NEW.sync_exception_at, COALESCE(NEW.synced_at, now())
  )
  ON CONFLICT (order_id, line_id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    item_name = EXCLUDED.item_name,
    sku = EXCLUDED.sku,
    item_description = EXCLUDED.item_description,
    item_type = EXCLUDED.item_type,
    item_type_text = EXCLUDED.item_type_text,
    quantity = EXCLUDED.quantity,
    unit = EXCLUDED.unit,
    location_id = EXCLUDED.location_id,
    location = EXCLUDED.location,
    pallet_qty = EXCLUDED.pallet_qty,
    layer_qty = EXCLUDED.layer_qty,
    piece_qty = EXCLUDED.piece_qty,
    section_qty = EXCLUDED.section_qty,
    to_plt = EXCLUDED.to_plt,
    to_lyr = EXCLUDED.to_lyr,
    to_sec = EXCLUDED.to_sec,
    to_pcs = EXCLUDED.to_pcs,
    item_weight = EXCLUDED.item_weight,
    packed_pallet_qty = EXCLUDED.packed_pallet_qty,
    packed_layer_qty = EXCLUDED.packed_layer_qty,
    packed_section_qty = EXCLUDED.packed_section_qty,
    packed_piece_qty = EXCLUDED.packed_piece_qty,
    confirmed = EXCLUDED.confirmed,
    confirmed_at = EXCLUDED.confirmed_at,
    loaded_qty = EXCLUDED.loaded_qty,
    loaded_uom = EXCLUDED.loaded_uom,
    netsuite_active = EXCLUDED.netsuite_active,
    sync_exception = EXCLUDED.sync_exception,
    sync_exception_at = EXCLUDED.sync_exception_at,
    synced_at = EXCLUDED.synced_at;

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

  INSERT INTO delivery_order_lines (
    id, order_id, line_id, item_id, item_name, sku, item_description,
    item_type, item_type_text, quantity, unit, location_id, location,
    pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec,
    to_pcs, item_weight, packed_pallet_qty, packed_layer_qty,
    packed_section_qty, packed_piece_qty, confirmed, confirmed_at,
    loaded_qty, loaded_uom, netsuite_active, sync_exception,
    sync_exception_at, synced_at
  ) VALUES (
    NEW.id, NEW.transfer_order_id, NEW.line_id, NEW.item_id, NEW.item_name,
    NEW.sku, NEW.item_description, NEW.item_type, NEW.item_type_text,
    NEW.quantity, NEW.unit, NEW.location_id, NEW.location, NEW.pallet_qty,
    NEW.layer_qty, NEW.piece_qty, NEW.section_qty, NEW.to_plt, NEW.to_lyr,
    NEW.to_sec, NEW.to_pcs, NEW.item_weight, COALESCE(NEW.packed_pallet_qty, 0),
    COALESCE(NEW.packed_layer_qty, 0), COALESCE(NEW.packed_section_qty, 0),
    COALESCE(NEW.packed_piece_qty, 0), COALESCE(NEW.confirmed, false),
    NEW.confirmed_at, COALESCE(NEW.loaded_qty, 0), NEW.loaded_uom,
    COALESCE(NEW.netsuite_active, true), NEW.sync_exception,
    NEW.sync_exception_at, COALESCE(NEW.synced_at, now())
  )
  ON CONFLICT (order_id, line_id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    item_name = EXCLUDED.item_name,
    sku = EXCLUDED.sku,
    item_description = EXCLUDED.item_description,
    item_type = EXCLUDED.item_type,
    item_type_text = EXCLUDED.item_type_text,
    quantity = EXCLUDED.quantity,
    unit = EXCLUDED.unit,
    location_id = EXCLUDED.location_id,
    location = EXCLUDED.location,
    pallet_qty = EXCLUDED.pallet_qty,
    layer_qty = EXCLUDED.layer_qty,
    piece_qty = EXCLUDED.piece_qty,
    section_qty = EXCLUDED.section_qty,
    to_plt = EXCLUDED.to_plt,
    to_lyr = EXCLUDED.to_lyr,
    to_sec = EXCLUDED.to_sec,
    to_pcs = EXCLUDED.to_pcs,
    item_weight = EXCLUDED.item_weight,
    packed_pallet_qty = EXCLUDED.packed_pallet_qty,
    packed_layer_qty = EXCLUDED.packed_layer_qty,
    packed_section_qty = EXCLUDED.packed_section_qty,
    packed_piece_qty = EXCLUDED.packed_piece_qty,
    confirmed = EXCLUDED.confirmed,
    confirmed_at = EXCLUDED.confirmed_at,
    loaded_qty = EXCLUDED.loaded_qty,
    loaded_uom = EXCLUDED.loaded_uom,
    netsuite_active = EXCLUDED.netsuite_active,
    sync_exception = EXCLUDED.sync_exception,
    sync_exception_at = EXCLUDED.sync_exception_at,
    synced_at = EXCLUDED.synced_at;

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

  INSERT INTO receiving_order_lines (
    id, order_id, line_id, item_id, item_name, item_type, item_type_text,
    item_description, sku, quantity, netsuite_received_qty, unit, item_weight,
    location_id, location, pallet_qty, layer_qty, piece_qty, section_qty,
    to_plt, to_lyr, to_sec, to_pcs, received_pallet_qty,
    received_layer_qty, received_section_qty, received_piece_qty,
    netsuite_active, sync_exception, sync_exception_at, confirmed_at,
    confirmed_by, raw, synced_at
  ) VALUES (
    NEW.id, NEW.purchase_order_id, NEW.line_id, NEW.item_id, NEW.item_name,
    NEW.item_type, NEW.item_type_text, NEW.item_description, NEW.sku,
    NEW.quantity, COALESCE(NEW.netsuite_received_qty, 0), NEW.unit, NEW.item_weight,
    NEW.location_id, NEW.location, NEW.pallet_qty, NEW.layer_qty, NEW.piece_qty,
    NEW.section_qty, NEW.to_plt, NEW.to_lyr, NEW.to_sec, NEW.to_pcs,
    COALESCE(NEW.received_pallet_qty, 0), COALESCE(NEW.received_layer_qty, 0),
    COALESCE(NEW.received_section_qty, 0), COALESCE(NEW.received_piece_qty, 0),
    COALESCE(NEW.netsuite_active, true), NEW.sync_exception,
    NEW.sync_exception_at, NEW.confirmed_at, NEW.confirmed_by,
    COALESCE(NEW.raw, '{}'::jsonb), COALESCE(NEW.synced_at, now())
  )
  ON CONFLICT (order_id, line_id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    item_name = EXCLUDED.item_name,
    item_type = EXCLUDED.item_type,
    item_type_text = EXCLUDED.item_type_text,
    item_description = EXCLUDED.item_description,
    sku = EXCLUDED.sku,
    quantity = EXCLUDED.quantity,
    netsuite_received_qty = EXCLUDED.netsuite_received_qty,
    unit = EXCLUDED.unit,
    item_weight = EXCLUDED.item_weight,
    location_id = EXCLUDED.location_id,
    location = EXCLUDED.location,
    pallet_qty = EXCLUDED.pallet_qty,
    layer_qty = EXCLUDED.layer_qty,
    piece_qty = EXCLUDED.piece_qty,
    section_qty = EXCLUDED.section_qty,
    to_plt = EXCLUDED.to_plt,
    to_lyr = EXCLUDED.to_lyr,
    to_sec = EXCLUDED.to_sec,
    to_pcs = EXCLUDED.to_pcs,
    received_pallet_qty = EXCLUDED.received_pallet_qty,
    received_layer_qty = EXCLUDED.received_layer_qty,
    received_section_qty = EXCLUDED.received_section_qty,
    received_piece_qty = EXCLUDED.received_piece_qty,
    netsuite_active = EXCLUDED.netsuite_active,
    sync_exception = EXCLUDED.sync_exception,
    sync_exception_at = EXCLUDED.sync_exception_at,
    confirmed_at = EXCLUDED.confirmed_at,
    confirmed_by = EXCLUDED.confirmed_by,
    raw = EXCLUDED.raw,
    synced_at = EXCLUDED.synced_at;

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
  IF NEW.line_stage <> 'receiving' THEN
    RETURN NEW;
  END IF;

  INSERT INTO receiving_order_lines (
    id, order_id, line_id, item_id, item_name, item_type, item_type_text,
    item_description, sku, quantity, netsuite_received_qty, unit, item_weight,
    location_id, location, pallet_qty, layer_qty, piece_qty, section_qty,
    to_plt, to_lyr, to_sec, to_pcs, received_pallet_qty,
    received_layer_qty, received_section_qty, received_piece_qty,
    netsuite_active, sync_exception, sync_exception_at, confirmed_at,
    confirmed_by, raw, synced_at
  ) VALUES (
    NEW.id, NEW.transfer_order_id, NEW.line_id, NEW.item_id, NEW.item_name,
    NEW.item_type, NEW.item_type_text, NEW.item_description, NEW.sku,
    NEW.quantity, COALESCE(NEW.netsuite_received_qty, 0), NEW.unit, NEW.item_weight,
    NEW.location_id, NEW.location, NEW.pallet_qty, NEW.layer_qty, NEW.piece_qty,
    NEW.section_qty, NEW.to_plt, NEW.to_lyr, NEW.to_sec, NEW.to_pcs,
    COALESCE(NEW.received_pallet_qty, 0), COALESCE(NEW.received_layer_qty, 0),
    COALESCE(NEW.received_section_qty, 0), COALESCE(NEW.received_piece_qty, 0),
    COALESCE(NEW.netsuite_active, true), NEW.sync_exception,
    NEW.sync_exception_at, NEW.confirmed_at, NEW.confirmed_by,
    COALESCE(NEW.raw, '{}'::jsonb), COALESCE(NEW.synced_at, now())
  )
  ON CONFLICT (order_id, line_id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    item_name = EXCLUDED.item_name,
    item_type = EXCLUDED.item_type,
    item_type_text = EXCLUDED.item_type_text,
    item_description = EXCLUDED.item_description,
    sku = EXCLUDED.sku,
    quantity = EXCLUDED.quantity,
    netsuite_received_qty = EXCLUDED.netsuite_received_qty,
    unit = EXCLUDED.unit,
    item_weight = EXCLUDED.item_weight,
    location_id = EXCLUDED.location_id,
    location = EXCLUDED.location,
    pallet_qty = EXCLUDED.pallet_qty,
    layer_qty = EXCLUDED.layer_qty,
    piece_qty = EXCLUDED.piece_qty,
    section_qty = EXCLUDED.section_qty,
    to_plt = EXCLUDED.to_plt,
    to_lyr = EXCLUDED.to_lyr,
    to_sec = EXCLUDED.to_sec,
    to_pcs = EXCLUDED.to_pcs,
    received_pallet_qty = EXCLUDED.received_pallet_qty,
    received_layer_qty = EXCLUDED.received_layer_qty,
    received_section_qty = EXCLUDED.received_section_qty,
    received_piece_qty = EXCLUDED.received_piece_qty,
    netsuite_active = EXCLUDED.netsuite_active,
    sync_exception = EXCLUDED.sync_exception,
    sync_exception_at = EXCLUDED.sync_exception_at,
    confirmed_at = EXCLUDED.confirmed_at,
    confirmed_by = EXCLUDED.confirmed_by,
    raw = EXCLUDED.raw,
    synced_at = EXCLUDED.synced_at;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sales_orders_dispatch_legacy ON sales_orders;
CREATE TRIGGER trg_sales_orders_dispatch_legacy
AFTER INSERT OR UPDATE ON sales_orders
FOR EACH ROW
EXECUTE FUNCTION mbbs_sales_order_dispatch_legacy_trigger();

DROP TRIGGER IF EXISTS trg_purchase_orders_dispatch_legacy ON purchase_orders;
CREATE TRIGGER trg_purchase_orders_dispatch_legacy
AFTER INSERT OR UPDATE ON purchase_orders
FOR EACH ROW
EXECUTE FUNCTION mbbs_purchase_order_dispatch_legacy_trigger();

DROP TRIGGER IF EXISTS trg_transfer_orders_dispatch_legacy ON transfer_orders;
CREATE TRIGGER trg_transfer_orders_dispatch_legacy
AFTER INSERT OR UPDATE ON transfer_orders
FOR EACH ROW
EXECUTE FUNCTION mbbs_transfer_order_dispatch_legacy_trigger();

DROP TRIGGER IF EXISTS trg_sales_lines_operator_legacy ON sales_order_lines;
CREATE TRIGGER trg_sales_lines_operator_legacy
AFTER INSERT OR UPDATE ON sales_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_sales_line_operator_legacy_trigger();

DROP TRIGGER IF EXISTS trg_transfer_lines_operator_legacy ON transfer_order_lines;
CREATE TRIGGER trg_transfer_lines_operator_legacy
AFTER INSERT OR UPDATE ON transfer_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_transfer_line_operator_legacy_trigger();

DROP TRIGGER IF EXISTS trg_purchase_lines_receiving_legacy ON purchase_order_lines;
CREATE TRIGGER trg_purchase_lines_receiving_legacy
AFTER INSERT OR UPDATE ON purchase_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_purchase_line_receiving_legacy_trigger();

DROP TRIGGER IF EXISTS trg_transfer_lines_receiving_legacy ON transfer_order_lines;
CREATE TRIGGER trg_transfer_lines_receiving_legacy
AFTER INSERT OR UPDATE ON transfer_order_lines
FOR EACH ROW
EXECUTE FUNCTION mbbs_transfer_line_receiving_legacy_trigger();
