CREATE TABLE IF NOT EXISTS dispatch_plan_load_assignments (
  id bigserial PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  plan_date date NOT NULL,
  load_id text NOT NULL,
  load_name text NOT NULL DEFAULT '',
  driver_login text NOT NULL DEFAULT '',
  driver_name text NOT NULL DEFAULT '',
  truck_id text NOT NULL DEFAULT '',
  truck_plate text NOT NULL DEFAULT '',
  switch_yard text NOT NULL DEFAULT '',
  parking_spot text NOT NULL DEFAULT '',
  planned_start_minute integer,
  planned_finish_minute integer,
  driver_sequence integer NOT NULL DEFAULT 0,
  started boolean NOT NULL DEFAULT false,
  completed boolean NOT NULL DEFAULT false,
  assignment jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_plan_load_assignments_load_not_blank CHECK (btrim(load_id) <> ''),
  CONSTRAINT dispatch_plan_load_assignments_plan_load_unique UNIQUE (plan_id, load_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_load_assignments_driver_date
  ON dispatch_plan_load_assignments (plan_date, lower(driver_login), planned_start_minute, driver_sequence);

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_load_assignments_truck_date
  ON dispatch_plan_load_assignments (plan_date, upper(truck_plate), planned_start_minute);

ALTER TABLE driver_day_records
  ADD COLUMN IF NOT EXISTS initial_truck_id text,
  ADD COLUMN IF NOT EXISTS initial_truck_plate text,
  ADD COLUMN IF NOT EXISTS current_truck_id text,
  ADD COLUMN IF NOT EXISTS current_truck_plate text,
  ADD COLUMN IF NOT EXISTS current_load_id text;

UPDATE driver_day_records
   SET initial_truck_id = COALESCE(NULLIF(initial_truck_id, ''), truck_id),
       initial_truck_plate = COALESCE(NULLIF(initial_truck_plate, ''), truck_plate),
       current_truck_id = COALESCE(NULLIF(current_truck_id, ''), truck_id),
       current_truck_plate = COALESCE(NULLIF(current_truck_plate, ''), truck_plate)
 WHERE initial_truck_id IS NULL
    OR initial_truck_plate IS NULL
    OR current_truck_id IS NULL
    OR current_truck_plate IS NULL;

ALTER TABLE driver_job_records
  ADD COLUMN IF NOT EXISTS job_details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS driver_truck_switch_records (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL UNIQUE,
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  plan_date date NOT NULL,
  driver_login text NOT NULL,
  from_truck_id text NOT NULL DEFAULT '',
  from_truck_plate text NOT NULL DEFAULT '',
  to_truck_id text NOT NULL DEFAULT '',
  to_truck_plate text NOT NULL DEFAULT '',
  switch_yard text NOT NULL DEFAULT '',
  parking_spot text NOT NULL DEFAULT '',
  next_load_id text NOT NULL DEFAULT '',
  planned_switch_minute integer,
  status text NOT NULL DEFAULT 'pending',
  samsara_username text NOT NULL DEFAULT '',
  samsara_driver_id text NOT NULL DEFAULT '',
  samsara_vehicle_id text NOT NULL DEFAULT '',
  samsara_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  samsara_error text NOT NULL DEFAULT '',
  confirmed_at timestamptz,
  overridden_at timestamptz,
  overridden_by text NOT NULL DEFAULT '',
  override_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_truck_switch_records_driver_not_blank CHECK (btrim(driver_login) <> ''),
  CONSTRAINT driver_truck_switch_records_target_not_blank CHECK (btrim(to_truck_plate) <> '')
);

CREATE INDEX IF NOT EXISTS idx_driver_truck_switch_records_driver_date
  ON driver_truck_switch_records (lower(driver_login), plan_date DESC, planned_switch_minute);

CREATE INDEX IF NOT EXISTS idx_driver_truck_switch_records_plan_load
  ON driver_truck_switch_records (plan_id, next_load_id, status);

INSERT INTO dispatch_plan_snapshot_history (
  plan_id, plan_date, revision, orders, trucks, summary,
  original_saved_at, archive_reason, session_id
)
SELECT p.id, p.plan_date, p.revision, s.orders, s.trucks, s.summary,
       s.saved_at, 'before_driver_oriented_planning', 'migration-035'
  FROM dispatch_plans p
  JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
 WHERE NOT EXISTS (
   SELECT 1
     FROM dispatch_plan_snapshot_history h
    WHERE h.plan_id = p.id
      AND h.archive_reason = 'before_driver_oriented_planning'
 );
