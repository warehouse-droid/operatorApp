CREATE TABLE IF NOT EXISTS dispatch_delivery_groups (
  group_ref text PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  plan_date date NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('sales_order', 'transfer_order')),
  truck_plate text NOT NULL DEFAULT '',
  load_name text NOT NULL DEFAULT '',
  parking_spot text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dispatch_delivery_group_members (
  group_ref text NOT NULL REFERENCES dispatch_delivery_groups(group_ref) ON DELETE CASCADE,
  member_order_ref text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_ref, member_order_ref),
  UNIQUE (group_ref, position)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_delivery_groups_active_type_date
  ON dispatch_delivery_groups (active, order_type, plan_date DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_delivery_groups_plan
  ON dispatch_delivery_groups (plan_id, active);

CREATE INDEX IF NOT EXISTS idx_dispatch_delivery_group_members_order_ref
  ON dispatch_delivery_group_members (member_order_ref);
