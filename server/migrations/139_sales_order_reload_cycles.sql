CREATE TABLE IF NOT EXISTS operator_reload_cycles (
  id bigserial PRIMARY KEY,
  sales_order_id bigint NOT NULL REFERENCES sales_orders(netsuite_id) ON DELETE RESTRICT,
  order_ref text NOT NULL,
  outbound_location_id bigint,
  cycle_number integer NOT NULL CHECK (cycle_number > 0),
  request_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'authorized'
    CHECK (status IN ('authorized', 'preparing', 'packed', 'in_progress', 'completed', 'cancelled')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  netsuite_status text NOT NULL DEFAULT '',
  netsuite_status_text text NOT NULL DEFAULT '',
  authorized_by text REFERENCES operators(id) ON DELETE SET NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  activity_started_at timestamptz,
  preparing_operator_id text REFERENCES operators(id) ON DELETE SET NULL,
  preparing_started_at timestamptz,
  completed_at timestamptz,
  cancelled_by text REFERENCES operators(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sales_order_id, cycle_number),
  CHECK (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_reload_cycles_active_sales_order
  ON operator_reload_cycles (sales_order_id)
  WHERE status IN ('authorized', 'preparing', 'packed', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_operator_reload_cycles_order_history
  ON operator_reload_cycles (sales_order_id, cycle_number DESC, id DESC);

CREATE TABLE IF NOT EXISTS operator_reload_cycle_lines (
  id bigserial PRIMARY KEY,
  cycle_id bigint NOT NULL REFERENCES operator_reload_cycles(id) ON DELETE RESTRICT,
  sales_order_line_id bigint NOT NULL REFERENCES sales_order_lines(id) ON DELETE RESTRICT,
  netsuite_line_id bigint,
  item_id bigint,
  item_name text NOT NULL DEFAULT '',
  sku text NOT NULL DEFAULT '',
  item_description text NOT NULL DEFAULT '',
  sales_uom text NOT NULL DEFAULT '',
  target_sales_qty numeric NOT NULL CHECK (target_sales_qty > 0),
  target_pallet_qty numeric NOT NULL DEFAULT 0 CHECK (target_pallet_qty >= 0),
  target_layer_qty numeric NOT NULL DEFAULT 0 CHECK (target_layer_qty >= 0),
  target_section_qty numeric NOT NULL DEFAULT 0 CHECK (target_section_qty >= 0),
  target_piece_qty numeric NOT NULL DEFAULT 0 CHECK (target_piece_qty >= 0),
  to_plt numeric NOT NULL DEFAULT 0 CHECK (to_plt >= 0),
  to_lyr numeric NOT NULL DEFAULT 0 CHECK (to_lyr >= 0),
  to_sec numeric NOT NULL DEFAULT 0 CHECK (to_sec >= 0),
  to_pcs numeric NOT NULL DEFAULT 0 CHECK (to_pcs >= 0),
  packed_pallet_qty numeric NOT NULL DEFAULT 0 CHECK (packed_pallet_qty >= 0),
  packed_layer_qty numeric NOT NULL DEFAULT 0 CHECK (packed_layer_qty >= 0),
  packed_section_qty numeric NOT NULL DEFAULT 0 CHECK (packed_section_qty >= 0),
  packed_piece_qty numeric NOT NULL DEFAULT 0 CHECK (packed_piece_qty >= 0),
  packed_sales_qty numeric NOT NULL DEFAULT 0 CHECK (packed_sales_qty >= 0),
  reloaded_pallet_qty numeric NOT NULL DEFAULT 0 CHECK (reloaded_pallet_qty >= 0),
  reloaded_layer_qty numeric NOT NULL DEFAULT 0 CHECK (reloaded_layer_qty >= 0),
  reloaded_section_qty numeric NOT NULL DEFAULT 0 CHECK (reloaded_section_qty >= 0),
  reloaded_piece_qty numeric NOT NULL DEFAULT 0 CHECK (reloaded_piece_qty >= 0),
  reloaded_sales_qty numeric NOT NULL DEFAULT 0
    CHECK (reloaded_sales_qty >= 0 AND reloaded_sales_qty <= target_sales_qty + 0.1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, sales_order_line_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_reload_cycle_lines_cycle
  ON operator_reload_cycle_lines (cycle_id, sales_order_line_id);

ALTER TABLE operator_load_records
  ADD COLUMN IF NOT EXISTS reload_cycle_id bigint REFERENCES operator_reload_cycles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS load_request_id uuid,
  ADD COLUMN IF NOT EXISTS attempt_line_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_load_records_request_id
  ON operator_load_records (load_request_id)
  WHERE load_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operator_load_records_order_attempts
  ON operator_load_records (order_family, order_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_operator_load_records_reload_cycle
  ON operator_load_records (reload_cycle_id, created_at, id)
  WHERE reload_cycle_id IS NOT NULL;

COMMENT ON TABLE operator_reload_cycles IS
  'Control-authorized, local-only Sales Order re-load workflow. Canonical Sales Order progress remains unchanged.';

COMMENT ON TABLE operator_reload_cycle_lines IS
  'Frozen re-load targets plus cycle-only Operator pack/load progress; never counted as new Sales Order fulfillment.';

COMMENT ON COLUMN operator_load_records.attempt_line_snapshot IS
  'Exact quantities physically handled by this one load attempt; legacy line_snapshot remains immutable.';
