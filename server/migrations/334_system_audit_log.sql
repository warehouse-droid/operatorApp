-- System audit log: failed/slow requests, process and background-job logs, crashes,
-- successful NetSuite postings and browser errors, shown in Admin -> Audit Log together
-- with the existing application audit streams.
CREATE TABLE IF NOT EXISTS system_audit_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  source text NOT NULL DEFAULT 'system',
  action text NOT NULL,
  outcome text,
  actor_type text NOT NULL DEFAULT 'system',
  actor_operator_id text,
  actor_name text,
  process_name text NOT NULL DEFAULT 'app',
  request_id text,
  http_method text,
  route text,
  status_code integer,
  duration_ms integer,
  order_ref text,
  message text,
  error_code text,
  repeat_count integer NOT NULL DEFAULT 1,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT system_audit_events_category
    CHECK (category IN ('request', 'netsuite', 'system', 'client')),
  CONSTRAINT system_audit_events_severity
    CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  CONSTRAINT system_audit_events_action_not_blank
    CHECK (NULLIF(btrim(action), '') IS NOT NULL),
  CONSTRAINT system_audit_events_repeat_count_positive
    CHECK (repeat_count > 0),
  CONSTRAINT system_audit_events_details_object
    CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_system_audit_events_occurred
  ON system_audit_events (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_system_audit_events_problems
  ON system_audit_events (occurred_at DESC, id DESC)
  WHERE severity IN ('warning', 'error', 'critical');

CREATE INDEX IF NOT EXISTS idx_system_audit_events_request
  ON system_audit_events (request_id)
  WHERE request_id IS NOT NULL;

-- Audit rows are evidence: they may be added but never edited.
CREATE OR REPLACE FUNCTION prevent_system_audit_event_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'system_audit_events rows are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_system_audit_events_append_only ON system_audit_events;
CREATE TRIGGER trg_system_audit_events_append_only
  BEFORE UPDATE ON system_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_system_audit_event_update();

COMMENT ON TABLE system_audit_events IS
  'Append-only system audit: failed/slow requests, process logs, crashes, NetSuite postings and browser errors.';

-- The Admin audit log reads every stream newest-first; without these indexes each page load
-- sorted the whole delivery audit table.
CREATE INDEX IF NOT EXISTS idx_delivery_audit_log_created
  ON delivery_audit_log (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_audit_events_created
  ON scm_reconciliation_audit_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_mbt_audit_events_occurred
  ON mbt_audit_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_boss_approval_events_created
  ON boss_approval_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_sales_order_if_audit_events_created
  ON dispatch_sales_order_if_audit_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_operator_netsuite_posting_attempts_started
  ON operator_netsuite_posting_attempts (started_at DESC, id DESC);
