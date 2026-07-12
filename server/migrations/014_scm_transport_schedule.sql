CREATE TABLE IF NOT EXISTS scm_transport_schedule (
  id bigserial PRIMARY KEY,
  order_kind text NOT NULL CHECK (order_kind IN ('PO', 'TO', 'VRMA')),
  source_table text,
  source_id bigint,
  order_ref text NOT NULL,
  display_ref text,
  is_special_order boolean NOT NULL DEFAULT false,
  method text NOT NULL DEFAULT 'MBT' CHECK (method IN ('MBT', 'Vendor', 'Customer Pickup')),
  pickup_point text,
  dropoff_point text,
  brand text,
  content text,
  weight_lbs numeric NOT NULL DEFAULT 0,
  packing_slip_ref text,
  group_ref text,
  status text NOT NULL DEFAULT 'Queued' CHECK (status IN (
    'Queued', 'Planned', 'Completed', 'Urgent', 'Cancelled', 'Hold',
    'Priority', 'Surplus Only', 'Book Appt', 'Partially Done'
  )),
  eta_date date,
  eta_time text,
  driver text,
  sla text,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_kind, order_ref)
);

CREATE INDEX IF NOT EXISTS idx_scm_transport_schedule_status_method
  ON scm_transport_schedule (status, method, order_kind);

CREATE INDEX IF NOT EXISTS idx_scm_transport_schedule_order_ref
  ON scm_transport_schedule (lower(order_ref));

CREATE INDEX IF NOT EXISTS idx_scm_transport_schedule_group_ref
  ON scm_transport_schedule (lower(group_ref))
  WHERE group_ref IS NOT NULL AND group_ref <> '';

CREATE TABLE IF NOT EXISTS scm_vrma_orders (
  id bigserial PRIMARY KEY,
  vrma_ref text NOT NULL UNIQUE,
  vendor text,
  local_vendor text,
  pickup_location text,
  dropoff_location text,
  status text NOT NULL DEFAULT 'Queued',
  method text NOT NULL DEFAULT 'MBT',
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scm_vrma_order_lines (
  id bigserial PRIMARY KEY,
  vrma_order_id bigint NOT NULL REFERENCES scm_vrma_orders(id) ON DELETE CASCADE,
  item_id bigint,
  sku text,
  item_name text NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  unit text,
  weight_lbs numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scm_schedule_groups (
  id bigserial PRIMARY KEY,
  group_ref text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS scm_schedule_group_members (
  id bigserial PRIMARY KEY,
  group_id bigint NOT NULL REFERENCES scm_schedule_groups(id) ON DELETE CASCADE,
  schedule_id bigint REFERENCES scm_transport_schedule(id) ON DELETE CASCADE,
  order_kind text NOT NULL,
  order_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, order_kind, order_ref)
);

CREATE TABLE IF NOT EXISTS scm_view_presets (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scm_user_view_presets (
  id bigserial PRIMARY KEY,
  user_id bigint,
  role text,
  preset_id bigint NOT NULL REFERENCES scm_view_presets(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, preset_id)
);

INSERT INTO scm_view_presets (name, description, config)
VALUES
  ('Dispatch', 'MBT shipments that dispatch needs to plan.', '{"filters":{"method":"MBT","excludeStatuses":["Cancelled","Hold"]},"columns":["orderRef","orderKind","specialOrder","pickupPoint","dropoffPoint","brand","content","weightLbs","packingSlipRef","groupRef","eta","driver","status"]}'::jsonb),
  ('Completed', 'Completed and partially completed shipments.', '{"filters":{"statuses":["Completed","Partially Done"]},"columns":["orderRef","orderKind","pickupPoint","dropoffPoint","brand","packingSlipRef","eta","driver","status"]}'::jsonb),
  ('Yard Manager', 'Inbound shipments by yard.', '{"filters":{"excludeStatuses":["Cancelled","Hold"]},"columns":["orderRef","orderKind","method","pickupPoint","dropoffPoint","brand","content","eta","status"]}'::jsonb),
  ('SCM Working', 'SCM editable transportation schedule.', '{"filters":{},"columns":["orderRef","orderKind","specialOrder","method","pickupPoint","dropoffPoint","brand","content","weightLbs","packingSlipRef","groupRef","eta","driver","status","sla"]}'::jsonb)
ON CONFLICT (name) DO NOTHING;
