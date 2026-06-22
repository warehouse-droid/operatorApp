ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'sales_order',
  ADD COLUMN IF NOT EXISTS source_location_id bigint,
  ADD COLUMN IF NOT EXISTS source_location text,
  ADD COLUMN IF NOT EXISTS destination_location_id bigint,
  ADD COLUMN IF NOT EXISTS destination_location text;

CREATE INDEX IF NOT EXISTS idx_delivery_orders_type_location
  ON delivery_orders (order_type, outbound_location_id, operator_status, trandate DESC);

CREATE TABLE IF NOT EXISTS receiving_orders (
  netsuite_id bigint PRIMARY KEY,
  order_type text NOT NULL,
  tranid text NOT NULL,
  trandate date,
  vendor_id bigint,
  vendor text,
  status text,
  status_text text,
  foreign_total numeric,
  source_location_id bigint,
  source_location text,
  destination_location_id bigint,
  destination_location text,
  netsuite_active boolean NOT NULL DEFAULT true,
  netsuite_missing_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS receiving_order_lines (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES receiving_orders(netsuite_id) ON DELETE CASCADE,
  line_id bigint,
  item_id bigint,
  item_name text,
  item_type text,
  item_type_text text,
  item_description text,
  sku text,
  quantity numeric,
  unit text,
  location_id bigint,
  location text,
  pallet_qty numeric,
  layer_qty numeric,
  piece_qty numeric,
  section_qty numeric,
  to_plt numeric,
  to_lyr numeric,
  to_sec numeric,
  to_pcs numeric,
  netsuite_active boolean NOT NULL DEFAULT true,
  sync_exception text,
  sync_exception_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_receiving_orders_type_vendor
  ON receiving_orders (order_type, vendor, netsuite_active, trandate DESC);

CREATE INDEX IF NOT EXISTS idx_receiving_orders_type_source
  ON receiving_orders (order_type, source_location_id, destination_location_id, netsuite_active, trandate DESC);

CREATE INDEX IF NOT EXISTS idx_receiving_lines_item
  ON receiving_order_lines (item_id, item_name);
