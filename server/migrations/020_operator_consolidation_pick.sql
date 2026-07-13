CREATE TABLE IF NOT EXISTS operator_consolidation_batches (
  id bigserial PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  location_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'released')),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  released_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_consolidation_batches_active
  ON operator_consolidation_batches (operator_id, location_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS operator_consolidation_orders (
  id bigserial PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES operator_consolidation_batches(id) ON DELETE CASCADE,
  order_key text NOT NULL,
  order_ref text NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('sales_order', 'group_order')),
  status text NOT NULL DEFAULT 'picking'
    CHECK (status IN ('picking', 'ready', 'packed', 'attention')),
  dispatch_plan_date date,
  dispatch_truck_plate text NOT NULL DEFAULT '',
  dispatch_load_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  packed_at timestamptz,
  UNIQUE (batch_id, order_key)
);

CREATE TABLE IF NOT EXISTS operator_consolidation_claims (
  id bigserial PRIMARY KEY,
  batch_order_id bigint NOT NULL REFERENCES operator_consolidation_orders(id) ON DELETE CASCADE,
  canonical_order_id bigint NOT NULL,
  canonical_order_ref text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_consolidation_claims_active_order
  ON operator_consolidation_claims (canonical_order_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operator_consolidation_claims_batch_order
  ON operator_consolidation_claims (batch_order_id);

CREATE TABLE IF NOT EXISTS operator_consolidation_lines (
  id bigserial PRIMARY KEY,
  batch_order_id bigint NOT NULL REFERENCES operator_consolidation_orders(id) ON DELETE CASCADE,
  line_key text NOT NULL,
  item_id text NOT NULL DEFAULT '',
  item_name text NOT NULL DEFAULT '',
  sales_uom text NOT NULL DEFAULT '',
  confirmed_pallet_qty numeric NOT NULL DEFAULT 0,
  confirmed_layer_qty numeric NOT NULL DEFAULT 0,
  confirmed_section_qty numeric NOT NULL DEFAULT 0,
  confirmed_piece_qty numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_order_id, line_key),
  CHECK (
    confirmed_pallet_qty >= 0
    AND confirmed_layer_qty >= 0
    AND confirmed_section_qty >= 0
    AND confirmed_piece_qty >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_operator_consolidation_lines_batch_order
  ON operator_consolidation_lines (batch_order_id);
