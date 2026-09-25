CREATE TABLE IF NOT EXISTS aggregate_requests (
  id bigserial PRIMARY KEY,
  yard_location_id bigint NOT NULL CHECK (yard_location_id IN (1,28,15,26)),
  service_date date NOT NULL,
  report_due_date date NOT NULL CHECK (report_due_date = service_date + 1),
  requested_by text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','confirmed','reported','rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  remarks text NOT NULL DEFAULT '',
  decision_reason text NOT NULL DEFAULT '',
  confirmed_by text REFERENCES operators(id) ON DELETE RESTRICT,
  confirmed_at timestamptz,
  reported_by text REFERENCES operators(id) ON DELETE RESTRICT,
  reported_at timestamptz,
  needs_review boolean NOT NULL DEFAULT false,
  acknowledged_by text REFERENCES operators(id) ON DELETE RESTRICT,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (yard_location_id, service_date),
  CHECK (NOT needs_review OR status = 'reported'),
  CHECK (status NOT IN ('confirmed','reported') OR confirmed_by IS NOT NULL),
  CHECK (status <> 'reported' OR reported_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS aggregate_requests_due_idx
  ON aggregate_requests (requested_by, yard_location_id, report_due_date)
  WHERE status IN ('submitted','confirmed');
CREATE INDEX IF NOT EXISTS aggregate_requests_queue_idx
  ON aggregate_requests (status, service_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS aggregate_requests_review_idx
  ON aggregate_requests (service_date, id) WHERE needs_review;

CREATE TABLE IF NOT EXISTS aggregate_request_lines (
  request_id bigint NOT NULL REFERENCES aggregate_requests(id) ON DELETE RESTRICT,
  material_code text NOT NULL CHECK (material_code IN ('gravel','hpb','screening','crusher_run','dump_concrete','dump_asphalt','dump_soil')),
  requested_loads integer NOT NULL CHECK (requested_loads BETWEEN 0 AND 1000000000),
  confirmed_loads integer CHECK (confirmed_loads BETWEEN 0 AND 1000000000),
  actual_loads integer CHECK (actual_loads BETWEEN 0 AND 1000000000),
  PRIMARY KEY (request_id, material_code)
);

CREATE TABLE IF NOT EXISTS aggregate_request_events (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES aggregate_requests(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  payload_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('submit','edit','confirm','reject','report','correct','acknowledge')),
  reason text NOT NULL DEFAULT '',
  before_snapshot jsonb,
  after_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, operation_id)
);
CREATE INDEX IF NOT EXISTS aggregate_request_events_request_idx ON aggregate_request_events (request_id, id);
