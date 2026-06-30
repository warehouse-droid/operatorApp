ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS item_weight numeric;

ALTER TABLE receiving_order_lines
  ADD COLUMN IF NOT EXISTS item_weight numeric;

ALTER TABLE local_co_order_lines
  ADD COLUMN IF NOT EXISTS item_weight numeric;

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS item_weight numeric;

CREATE OR REPLACE VIEW sales_orders AS
SELECT
  netsuite_id,
  tranid,
  trandate,
  customer_id,
  customer,
  status,
  status_text,
  foreign_total,
  order_location_id,
  order_location,
  outbound_location_id,
  outbound_location,
  delivery_method_id,
  delivery_method AS sales_order_type,
  memo,
  expected_delivery_date,
  dispatch_address,
  dispatch_window_start,
  dispatch_window_end,
  dispatch_instructions,
  operator_status,
  local_yard_order_status,
  netsuite_active,
  synced_at,
  dispatch_parse_source,
  dispatch_note_hash,
  dispatch_parsed_at,
  fulfillment_status,
  dispatch_planned,
  dispatch_plan_date,
  dispatch_truck_plate,
  dispatch_load_name,
  dispatch_parking_spot,
  dispatch_planned_at,
  netsuite_missing_at
FROM delivery_orders
WHERE order_type = 'sales_order';

CREATE OR REPLACE VIEW sales_order_lines AS
SELECT
  l.id,
  l.order_id AS sales_order_id,
  l.line_id,
  l.item_id,
  l.item_name,
  l.sku,
  l.item_description,
  l.item_type,
  l.item_type_text,
  l.quantity,
  l.unit,
  l.pallet_qty,
  l.layer_qty,
  l.section_qty,
  l.piece_qty,
  l.to_plt,
  l.to_lyr,
  l.to_sec,
  l.to_pcs,
  l.packed_pallet_qty,
  l.packed_layer_qty,
  l.packed_section_qty,
  l.packed_piece_qty,
  l.confirmed,
  l.confirmed_at,
  l.loaded_qty,
  l.loaded_uom,
  l.netsuite_active,
  l.sync_exception,
  l.synced_at,
  l.location_id,
  l.location,
  l.item_weight
FROM delivery_order_lines l
JOIN delivery_orders o ON o.netsuite_id = l.order_id
WHERE o.order_type = 'sales_order';

CREATE OR REPLACE VIEW transfer_order_lines AS
SELECT
  'outbound' AS line_stage,
  l.id,
  l.order_id AS transfer_order_id,
  l.line_id,
  l.item_id,
  l.item_name,
  l.sku,
  l.item_description,
  l.quantity,
  l.unit,
  l.pallet_qty,
  l.layer_qty,
  l.section_qty,
  l.piece_qty,
  l.loaded_qty,
  l.loaded_uom,
  l.netsuite_active,
  l.sync_exception,
  l.synced_at,
  l.item_type,
  l.item_type_text,
  l.location_id,
  l.location,
  l.to_plt,
  l.to_lyr,
  l.to_sec,
  l.to_pcs,
  l.packed_pallet_qty,
  l.packed_layer_qty,
  l.packed_section_qty,
  l.packed_piece_qty,
  0::numeric AS received_pallet_qty,
  0::numeric AS received_layer_qty,
  0::numeric AS received_section_qty,
  0::numeric AS received_piece_qty,
  0::numeric AS netsuite_received_qty,
  l.item_weight
FROM delivery_order_lines l
JOIN delivery_orders o ON o.netsuite_id = l.order_id
WHERE o.order_type = 'transfer_order'
UNION ALL
SELECT
  'receiving' AS line_stage,
  l.id,
  l.order_id AS transfer_order_id,
  l.line_id,
  l.item_id,
  l.item_name,
  l.sku,
  l.item_description,
  l.quantity,
  l.unit,
  l.pallet_qty,
  l.layer_qty,
  l.section_qty,
  l.piece_qty,
  l.netsuite_received_qty AS loaded_qty,
  l.unit AS loaded_uom,
  l.netsuite_active,
  l.sync_exception,
  l.synced_at,
  l.item_type,
  l.item_type_text,
  l.location_id,
  l.location,
  l.to_plt,
  l.to_lyr,
  l.to_sec,
  l.to_pcs,
  0::numeric AS packed_pallet_qty,
  0::numeric AS packed_layer_qty,
  0::numeric AS packed_section_qty,
  0::numeric AS packed_piece_qty,
  l.received_pallet_qty,
  l.received_layer_qty,
  l.received_section_qty,
  l.received_piece_qty,
  l.netsuite_received_qty,
  l.item_weight
FROM receiving_order_lines l
JOIN receiving_orders o ON o.netsuite_id = l.order_id
WHERE o.order_type = 'transfer_order';

CREATE OR REPLACE VIEW purchase_order_lines AS
SELECT
  l.id,
  l.order_id AS purchase_order_id,
  l.line_id,
  l.item_id,
  l.item_name,
  l.sku,
  l.item_description,
  l.item_type,
  l.item_type_text,
  l.quantity,
  l.unit,
  l.location_id,
  l.location,
  l.pallet_qty,
  l.layer_qty,
  l.section_qty,
  l.piece_qty,
  l.to_plt,
  l.to_lyr,
  l.to_sec,
  l.to_pcs,
  l.received_pallet_qty,
  l.received_layer_qty,
  l.received_section_qty,
  l.received_piece_qty,
  l.netsuite_received_qty,
  l.netsuite_active,
  l.sync_exception,
  l.synced_at,
  l.item_weight
FROM receiving_order_lines l
JOIN receiving_orders o ON o.netsuite_id = l.order_id
WHERE o.order_type = 'purchase_order';

CREATE OR REPLACE VIEW co_order_lines AS
SELECT * FROM local_co_order_lines;
