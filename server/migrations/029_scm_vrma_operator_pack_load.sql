ALTER TABLE scm_vrma_orders
  ADD COLUMN IF NOT EXISTS operator_status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS local_yard_order_status text NOT NULL DEFAULT 'Open',
  ADD COLUMN IF NOT EXISTS preparing_operator_id text,
  ADD COLUMN IF NOT EXISTS preparing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS loaded_at timestamptz;

ALTER TABLE scm_vrma_order_lines
  ADD COLUMN IF NOT EXISTS packed_pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packed_layer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packed_section_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packed_piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packed_sales_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loaded_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loaded_uom text,
  ADD COLUMN IF NOT EXISTS confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_scm_vrma_orders_operator_status
  ON scm_vrma_orders (operator_status, pickup_location);

CREATE INDEX IF NOT EXISTS idx_scm_vrma_order_lines_order
  ON scm_vrma_order_lines (vrma_order_id);

COMMENT ON COLUMN scm_vrma_orders.operator_status IS
  'Local Operator pack/load state only. Never synchronized to NetSuite.';

COMMENT ON COLUMN scm_vrma_order_lines.loaded_qty IS
  'Locally loaded stock/sales quantity for Operator VRMA activity; inventory-neutral and NetSuite-neutral.';
