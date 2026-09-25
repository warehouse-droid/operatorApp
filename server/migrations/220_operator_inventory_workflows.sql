CREATE TABLE inventory_count_sheets (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  location_id bigint NOT NULL CHECK (location_id IN (1,28,15,26)),
  title text NOT NULL,
  created_by text NOT NULL REFERENCES operators(id),
  owner_id text REFERENCES operators(id),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_progress','submitted','cancelled')),
  revision integer NOT NULL DEFAULT 1,
  attempt integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  CHECK (status NOT IN ('in_progress','submitted') OR owner_id IS NOT NULL)
);
CREATE TABLE inventory_count_sheet_items (
  sheet_id bigint NOT NULL REFERENCES inventory_count_sheets(id),
  item_id bigint NOT NULL REFERENCES inventory_items(item_id),
  position integer NOT NULL,
  PRIMARY KEY(sheet_id,item_id)
);
CREATE TABLE inventory_count_sheet_counts (
  sheet_id bigint NOT NULL REFERENCES inventory_count_sheets(id),
  attempt integer NOT NULL,
  item_id bigint NOT NULL REFERENCES inventory_items(item_id),
  operator_id text NOT NULL REFERENCES operators(id),
  quantity numeric NOT NULL CHECK(quantity >= 0),
  unit text NOT NULL,
  values jsonb NOT NULL,
  conversions jsonb NOT NULL,
  system_on_hand numeric NOT NULL,
  system_available numeric NOT NULL,
  variance numeric NOT NULL,
  inventory_synced_at timestamptz,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(sheet_id,attempt,item_id)
);
CREATE TABLE inventory_count_sheet_events (
  id bigserial PRIMARY KEY,
  sheet_id bigint NOT NULL REFERENCES inventory_count_sheets(id),
  actor_id text NOT NULL REFERENCES operators(id),
  action text NOT NULL,
  attempt integer NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_count_sheets_yard_status ON inventory_count_sheets(location_id,status,updated_at DESC);
CREATE TABLE inventory_damage_months (
  id bigserial PRIMARY KEY,
  location_id bigint NOT NULL CHECK(location_id IN (1,28,15,26)),
  month text NOT NULL CHECK(month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  transfer_id bigint UNIQUE,
  transfer_ref text,
  external_id text NOT NULL UNIQUE,
  UNIQUE(location_id,month)
);
CREATE TABLE inventory_damage_reports (
  id uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  month_id bigint NOT NULL REFERENCES inventory_damage_months(id),
  operator_id text NOT NULL REFERENCES operators(id),
  item_id bigint NOT NULL REFERENCES inventory_items(item_id),
  item_name text NOT NULL,
  quantity numeric NOT NULL CHECK(quantity > 0),
  unit text NOT NULL,
  unit_id bigint NOT NULL,
  values jsonb NOT NULL,
  conversions jsonb NOT NULL,
  reason_id integer NOT NULL CHECK(reason_id BETWEEN 5 AND 9),
  reason_label text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posting','posted','attention')),
  safe_to_retry boolean NOT NULL DEFAULT true,
  transfer_line integer,
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0,
  accepted_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inventory_damage_photos (
  report_id uuid NOT NULL REFERENCES inventory_damage_reports(id),
  photo_reference text NOT NULL UNIQUE,
  position integer NOT NULL,
  PRIMARY KEY(report_id,position)
);
CREATE TABLE inventory_damage_events (
  id bigserial PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES inventory_damage_reports(id),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_damage_pending ON inventory_damage_reports(created_at) WHERE status IN ('pending','posting');
