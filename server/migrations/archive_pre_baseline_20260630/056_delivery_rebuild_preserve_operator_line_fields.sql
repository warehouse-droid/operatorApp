CREATE OR REPLACE FUNCTION mbbs_rebuild_sales_order_lines(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM sales_order_lines WHERE sales_order_id = p_order_id;

  INSERT INTO sales_order_lines (
    id, sales_order_id, line_id, item_id, item_name, sku, item_description,
    item_type, item_type_text, quantity, unit, pallet_qty, layer_qty,
    section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs,
    packed_pallet_qty, packed_layer_qty, packed_section_qty,
    packed_piece_qty, confirmed, confirmed_at, loaded_qty, loaded_uom,
    netsuite_active, sync_exception, synced_at, location_id, location,
    item_weight, sync_exception_at
  )
  SELECT
    l.id, l.order_id, l.line_id, l.item_id, l.item_name, l.sku,
    l.item_description, l.item_type, l.item_type_text, l.quantity, l.unit,
    l.pallet_qty, l.layer_qty, l.section_qty, l.piece_qty, l.to_plt,
    l.to_lyr, l.to_sec, l.to_pcs, l.packed_pallet_qty, l.packed_layer_qty,
    l.packed_section_qty, l.packed_piece_qty, l.confirmed, l.confirmed_at,
    l.loaded_qty, l.loaded_uom, l.netsuite_active, l.sync_exception,
    l.synced_at, l.location_id, l.location, l.item_weight, l.sync_exception_at
  FROM delivery_order_lines l
  JOIN delivery_orders o ON o.netsuite_id = l.order_id
  WHERE l.order_id = p_order_id
    AND o.order_type = 'sales_order';
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
      netsuite_received_qty, item_weight, sync_exception_at, confirmed,
      confirmed_at
    )
    SELECT
      'outbound', l.id, l.order_id, l.line_id, l.item_id, l.item_name, l.sku,
      l.item_description, l.quantity, l.unit, l.pallet_qty, l.layer_qty,
      l.section_qty, l.piece_qty, l.loaded_qty, l.loaded_uom,
      l.netsuite_active, l.sync_exception, l.synced_at, l.item_type,
      l.item_type_text, l.location_id, l.location, l.to_plt, l.to_lyr,
      l.to_sec, l.to_pcs, l.packed_pallet_qty, l.packed_layer_qty,
      l.packed_section_qty, l.packed_piece_qty, 0, 0, 0, 0, 0,
      l.item_weight, l.sync_exception_at, l.confirmed, l.confirmed_at
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
      confirmed_at, confirmed_by, confirmed
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
      l.confirmed_at, l.confirmed_by, (l.confirmed_at IS NOT NULL)
    FROM receiving_order_lines l
    JOIN receiving_orders o ON o.netsuite_id = l.order_id
    WHERE l.order_id = p_order_id
      AND o.order_type = 'transfer_order';
  END IF;
END;
$$;
