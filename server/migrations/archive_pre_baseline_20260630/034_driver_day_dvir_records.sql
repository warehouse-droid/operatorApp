CREATE TABLE IF NOT EXISTS driver_day_records (
  id bigserial PRIMARY KEY,
  driver_login text NOT NULL,
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  plan_date date NOT NULL,
  truck_id text,
  truck_plate text,
  samsara_username text,
  samsara_driver_id text,
  samsara_vehicle_id text,
  samsara_assignment_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  samsara_on_duty_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  samsara_off_duty_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  pre_dvir_photo_data_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  post_dvir_photo_data_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  pre_dvir_completed_at timestamptz,
  post_dvir_completed_at timestamptz,
  on_duty_at timestamptz,
  off_duty_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_login, plan_date)
);

CREATE INDEX IF NOT EXISTS idx_driver_day_records_driver_date
  ON driver_day_records (driver_login, plan_date DESC);
