CREATE TABLE IF NOT EXISTS driver_job_records (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL UNIQUE,
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  plan_date date,
  driver_login text NOT NULL,
  truck_id text,
  truck_plate text,
  load_id text,
  load_name text,
  stop_id text,
  stop_type text NOT NULL,
  order_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  photo_data_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'complete',
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_job_records_driver_date
  ON driver_job_records (driver_login, plan_date DESC, completed_at DESC);
