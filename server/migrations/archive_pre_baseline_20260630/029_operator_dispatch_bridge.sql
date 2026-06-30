ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS local_yard_order_status text NOT NULL DEFAULT 'Open',
  ADD COLUMN IF NOT EXISTS dispatch_planned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dispatch_plan_date date,
  ADD COLUMN IF NOT EXISTS dispatch_truck_plate text,
  ADD COLUMN IF NOT EXISTS dispatch_load_name text,
  ADD COLUMN IF NOT EXISTS dispatch_parking_spot text,
  ADD COLUMN IF NOT EXISTS dispatch_planned_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_delivery_orders_local_yard_status
  ON delivery_orders (local_yard_order_status, dispatch_planned, trandate DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_orders_dispatch_plan
  ON delivery_orders (dispatch_plan_date, dispatch_truck_plate, dispatch_load_name);

CREATE TABLE IF NOT EXISTS dispatch_operator_requests (
  id bigserial PRIMARY KEY,
  request_type text NOT NULL,
  order_ref text NOT NULL,
  source_order_type text,
  status text NOT NULL DEFAULT 'open',
  requested_by text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_by text,
  resolved_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_dispatch_operator_requests_order
  ON dispatch_operator_requests (order_ref, status, requested_at DESC);
