CREATE TABLE IF NOT EXISTS google_maps_usage_ledger (
  id bigserial PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  subsystem text NOT NULL,
  api text NOT NULL,
  reason text NOT NULL,
  request_fingerprint text NOT NULL DEFAULT '',
  actor_id text NOT NULL DEFAULT '',
  session_id text NOT NULL DEFAULT '',
  requested_units integer NOT NULL DEFAULT 1 CHECK (requested_units > 0 AND requested_units <= 1000),
  admitted_units integer NOT NULL DEFAULT 0 CHECK (admitted_units >= 0 AND admitted_units <= requested_units),
  admitted boolean NOT NULL DEFAULT false,
  admission_reason text NOT NULL,
  budget_state text NOT NULL CHECK (budget_state IN ('normal', 'conserve', 'reserve', 'exhausted')),
  outcome text NOT NULL DEFAULT 'not_called' CHECK (
    outcome IN ('not_called', 'admitted', 'succeeded', 'failed', 'timeout', 'invalid_request', 'invalid_response')
  ),
  http_status integer,
  latency_ms integer,
  completed_at timestamptz,
  CHECK (
    (admitted AND admitted_units = requested_units)
    OR (NOT admitted AND admitted_units = 0)
  )
);

CREATE INDEX IF NOT EXISTS google_maps_usage_ledger_rolling_idx
  ON google_maps_usage_ledger (requested_at DESC)
  INCLUDE (subsystem, admitted, admitted_units);

CREATE INDEX IF NOT EXISTS google_maps_usage_ledger_subsystem_idx
  ON google_maps_usage_ledger (subsystem, requested_at DESC)
  WHERE admitted;
