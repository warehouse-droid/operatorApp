CREATE OR REPLACE FUNCTION mbbs_rebuild_purchase_order(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM purchase_orders WHERE netsuite_id = p_order_id;

  INSERT INTO purchase_orders (
    netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
    foreign_total, destination_location_id, destination_location, memo,
    dispatch_vendor_yard, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, receipt_status,
    netsuite_active, synced_at, source_location_id, source_location,
    expected_delivery_date, dispatch_parse_source, dispatch_note_hash,
    dispatch_parsed_at, netsuite_missing_at, last_item_receipt_id,
    last_item_receipt_tranid, received_at
  )
  SELECT
    netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
    foreign_total, destination_location_id, destination_location, memo,
    dispatch_vendor_yard, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, receipt_status,
    netsuite_active, synced_at, source_location_id, source_location,
    expected_delivery_date, dispatch_parse_source, dispatch_note_hash,
    dispatch_parsed_at, netsuite_missing_at, last_item_receipt_id,
    last_item_receipt_tranid, received_at
  FROM receiving_orders
  WHERE netsuite_id = p_order_id
    AND order_type = 'purchase_order';
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_purchase_order_lines(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM purchase_order_lines WHERE purchase_order_id = p_order_id;

  INSERT INTO purchase_order_lines (
    id, purchase_order_id, line_id, item_id, item_name, sku, item_description,
    item_type, item_type_text, quantity, unit, location_id, location,
    pallet_qty, layer_qty, section_qty, piece_qty, to_plt, to_lyr, to_sec,
    to_pcs, received_pallet_qty, received_layer_qty, received_section_qty,
    received_piece_qty, netsuite_received_qty, netsuite_active,
    sync_exception, synced_at, item_weight, sync_exception_at, raw,
    confirmed_at, confirmed_by
  )
  SELECT
    l.id, l.order_id, l.line_id, l.item_id, l.item_name, l.sku,
    l.item_description, l.item_type, l.item_type_text, l.quantity, l.unit,
    l.location_id, l.location, l.pallet_qty, l.layer_qty, l.section_qty,
    l.piece_qty, l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
    l.received_pallet_qty, l.received_layer_qty, l.received_section_qty,
    l.received_piece_qty, l.netsuite_received_qty, l.netsuite_active,
    l.sync_exception, l.synced_at, l.item_weight, l.sync_exception_at, l.raw,
    l.confirmed_at, l.confirmed_by
  FROM receiving_order_lines l
  JOIN receiving_orders o ON o.netsuite_id = l.order_id
  WHERE l.order_id = p_order_id
    AND o.order_type = 'purchase_order';
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
    dispatch_parsed_at, local_yard_order_status, fulfillment_status,
    dispatch_planned, dispatch_plan_date, dispatch_truck_plate,
    dispatch_load_name, dispatch_parking_spot, dispatch_planned_at,
    netsuite_missing_at, last_item_receipt_id, last_item_receipt_tranid,
    received_at
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
    r.received_at
  FROM (SELECT * FROM delivery_orders WHERE order_type = 'transfer_order' AND netsuite_id = p_order_id) d
  FULL JOIN (SELECT * FROM receiving_orders WHERE order_type = 'transfer_order' AND netsuite_id = p_order_id) r
    ON r.netsuite_id = d.netsuite_id
  WHERE COALESCE(d.netsuite_id, r.netsuite_id) IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_transfer_order_lines(p_order_id bigint, p_stage text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM transfer_order_lines
  WHERE transfer_order_id = p_order_id
    AND line_stage = p_stage;

  IF p_stage = 'outbound' THEN
    INSERT INTO transfer_order_lines (
      line_stage, id, transfer_order_id, line_id, item_id, item_name, sku,
      item_description, quantity, unit, pallet_qty, layer_qty, section_qty,
      piece_qty, loaded_qty, loaded_uom, netsuite_active, sync_exception,
      synced_at, item_type, item_type_text, location_id, location, to_plt,
      to_lyr, to_sec, to_pcs, packed_pallet_qty, packed_layer_qty,
      packed_section_qty, packed_piece_qty, received_pallet_qty,
      received_layer_qty, received_section_qty, received_piece_qty,
      netsuite_received_qty, item_weight
    )
    SELECT
      'outbound', l.id, l.order_id, l.line_id, l.item_id, l.item_name, l.sku,
      l.item_description, l.quantity, l.unit, l.pallet_qty, l.layer_qty,
      l.section_qty, l.piece_qty, l.loaded_qty, l.loaded_uom,
      l.netsuite_active, l.sync_exception, l.synced_at, l.item_type,
      l.item_type_text, l.location_id, l.location, l.to_plt, l.to_lyr,
      l.to_sec, l.to_pcs, l.packed_pallet_qty, l.packed_layer_qty,
      l.packed_section_qty, l.packed_piece_qty, 0, 0, 0, 0, 0, l.item_weight
    FROM delivery_order_lines l
    JOIN delivery_orders o ON o.netsuite_id = l.order_id
    WHERE l.order_id = p_order_id
      AND o.order_type = 'transfer_order';
  ELSIF p_stage = 'receiving' THEN
    INSERT INTO transfer_order_lines (
      line_stage, id, transfer_order_id, line_id, item_id, item_name, sku,
      item_description, quantity, unit, pallet_qty, layer_qty, section_qty,
      piece_qty, loaded_qty, loaded_uom, netsuite_active, sync_exception,
      synced_at, item_type, item_type_text, location_id, location, to_plt,
      to_lyr, to_sec, to_pcs, packed_pallet_qty, packed_layer_qty,
      packed_section_qty, packed_piece_qty, received_pallet_qty,
      received_layer_qty, received_section_qty, received_piece_qty,
      netsuite_received_qty, item_weight, sync_exception_at, raw,
      confirmed_at, confirmed_by
    )
    SELECT
      'receiving', l.id, l.order_id, l.line_id, l.item_id, l.item_name, l.sku,
      l.item_description, l.quantity, l.unit, l.pallet_qty, l.layer_qty,
      l.section_qty, l.piece_qty, l.netsuite_received_qty, l.unit,
      l.netsuite_active, l.sync_exception, l.synced_at, l.item_type,
      l.item_type_text, l.location_id, l.location, l.to_plt, l.to_lyr,
      l.to_sec, l.to_pcs, 0, 0, 0, 0, l.received_pallet_qty,
      l.received_layer_qty, l.received_section_qty, l.received_piece_qty,
      l.netsuite_received_qty, l.item_weight, l.sync_exception_at, l.raw,
      l.confirmed_at, l.confirmed_by
    FROM receiving_order_lines l
    JOIN receiving_orders o ON o.netsuite_id = l.order_id
    WHERE l.order_id = p_order_id
      AND o.order_type = 'transfer_order';
  END IF;
END;
$$;
