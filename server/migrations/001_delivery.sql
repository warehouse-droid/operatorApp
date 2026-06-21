CREATE TABLE IF NOT EXISTS netsuite_tokens (
  id integer PRIMARY KEY DEFAULT 1,
  access_token text NOT NULL,
  refresh_token text,
  token_type text,
  expires_at timestamptz,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT single_token_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS delivery_orders (
  netsuite_id bigint PRIMARY KEY,
  tranid text NOT NULL,
  trandate date,
  customer_id bigint,
  customer text,
  status text,
  status_text text,
  foreign_total numeric,
  order_location_id bigint,
  order_location text,
  outbound_location_id bigint,
  outbound_location text,
  delivery_method_id bigint,
  delivery_method text,
  prepared boolean NOT NULL DEFAULT false,
  prepared_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_order_lines (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES delivery_orders(netsuite_id) ON DELETE CASCADE,
  line_id bigint,
  item_id bigint,
  item_name text,
  sku text,
  quantity numeric,
  unit text,
  location_id bigint,
  location text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, line_id)
);

CREATE TABLE IF NOT EXISTS delivery_preparation_records (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES delivery_orders(netsuite_id) ON DELETE CASCADE,
  operator_name text,
  photo_path text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_orders_prepared_date
  ON delivery_orders (prepared, trandate DESC);
