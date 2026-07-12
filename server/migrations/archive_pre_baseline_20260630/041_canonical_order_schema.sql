CREATE TABLE IF NOT EXISTS operator_load_records (
  id bigserial PRIMARY KEY,
  load_type text NOT NULL,
  order_family text NOT NULL,
  order_id bigint,
  order_ref text,
  source_table text,
  source_record_id bigint,
  operator_id text REFERENCES operators(id) ON DELETE SET NULL,
  photo_data_url text NOT NULL DEFAULT '',
  loaded_qty numeric,
  loaded_uom text,
  line_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_record_id)
);

INSERT INTO operator_load_records (
  load_type, order_family, order_id, order_ref, source_table, source_record_id,
  operator_id, photo_data_url, loaded_qty, loaded_uom, line_snapshot, response, created_at
)
SELECT
  'customer_pickup_load',
  'sales_order',
  c.order_id,
  o.tranid,
  'customer_pickup_load_records',
  c.id,
  c.operator_id,
  c.photo_data_url,
  c.loaded_qty,
  c.loaded_uom,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'lineId', l.line_id,
      'itemId', l.item_id,
      'itemName', l.item_name,
      'description', l.item_description,
      'quantity', l.quantity,
      'unit', l.unit,
      'loadedQty', l.loaded_qty,
      'loadedUom', l.loaded_uom
    ) ORDER BY l.line_id NULLS LAST, l.id)
    FROM delivery_order_lines l
    WHERE l.order_id = c.order_id
  ), '[]'::jsonb),
  c.response,
  c.created_at
FROM customer_pickup_load_records c
LEFT JOIN delivery_orders o ON o.netsuite_id = c.order_id
ON CONFLICT (source_table, source_record_id) DO NOTHING;

INSERT INTO operator_load_records (
  load_type, order_family, order_id, order_ref, source_table, source_record_id,
  operator_id, photo_data_url, loaded_qty, loaded_uom, line_snapshot, response, created_at
)
SELECT
  CASE
    WHEN o.order_type = 'transfer_order' THEN 'transfer_order_load'
    ELSE 'sales_order_delivery_load'
  END,
  CASE
    WHEN o.order_type = 'transfer_order' THEN 'transfer_order'
    ELSE 'sales_order'
  END,
  f.order_id,
  o.tranid,
  'delivery_fulfillment_records',
  f.id,
  f.operator_id,
  f.photo_data_url,
  NULL,
  NULL,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'lineId', l.line_id,
      'itemId', l.item_id,
      'itemName', l.item_name,
      'description', l.item_description,
      'quantity', l.quantity,
      'unit', l.unit,
      'loadedQty', l.loaded_qty,
      'loadedUom', l.loaded_uom
    ) ORDER BY l.line_id NULLS LAST, l.id)
    FROM delivery_order_lines l
    WHERE l.order_id = f.order_id
  ), '[]'::jsonb),
  f.response,
  f.created_at
FROM delivery_fulfillment_records f
LEFT JOIN delivery_orders o ON o.netsuite_id = f.order_id
ON CONFLICT (source_table, source_record_id) DO NOTHING;

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
  synced_at
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
  l.synced_at
FROM delivery_order_lines l
JOIN delivery_orders o ON o.netsuite_id = l.order_id
WHERE o.order_type = 'sales_order';

CREATE OR REPLACE VIEW transfer_orders AS
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
  GREATEST(COALESCE(d.synced_at, '-infinity'::timestamptz), COALESCE(r.synced_at, '-infinity'::timestamptz)) AS synced_at
FROM (SELECT * FROM delivery_orders WHERE order_type = 'transfer_order') d
FULL JOIN (SELECT * FROM receiving_orders WHERE order_type = 'transfer_order') r
  ON r.netsuite_id = d.netsuite_id;

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
  l.synced_at
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
  l.synced_at
FROM receiving_order_lines l
JOIN receiving_orders o ON o.netsuite_id = l.order_id
WHERE o.order_type = 'transfer_order';

CREATE OR REPLACE VIEW purchase_orders AS
SELECT
  netsuite_id,
  tranid,
  trandate,
  vendor_id,
  vendor,
  status,
  status_text,
  foreign_total,
  destination_location_id,
  destination_location,
  memo,
  dispatch_vendor_yard,
  dispatch_address,
  dispatch_window_start,
  dispatch_window_end,
  dispatch_instructions,
  receipt_status,
  netsuite_active,
  synced_at
FROM receiving_orders
WHERE order_type = 'purchase_order';

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
  l.synced_at
FROM receiving_order_lines l
JOIN receiving_orders o ON o.netsuite_id = l.order_id
WHERE o.order_type = 'purchase_order';

CREATE OR REPLACE VIEW co_orders AS
SELECT * FROM local_co_orders;

CREATE OR REPLACE VIEW co_order_lines AS
SELECT * FROM local_co_order_lines;

COMMENT ON VIEW sales_orders IS 'Canonical sales order view. Delivery and pickup are both sales orders; sales_order_type follows NetSuite delivery_method.';
COMMENT ON VIEW transfer_orders IS 'Canonical transfer order view. Combines outbound and receiving-side local state for the same NetSuite transfer order.';
COMMENT ON VIEW purchase_orders IS 'Canonical purchase order view backed by receiving_orders rows where order_type = purchase_order.';
COMMENT ON VIEW co_orders IS 'Canonical local transit/consolidation order view backed by local_co_orders.';
COMMENT ON TABLE operator_load_records IS 'Unified operator load/photo records for sales pickup, sales delivery load, and transfer load.';
