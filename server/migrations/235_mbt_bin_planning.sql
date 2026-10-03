-- BIN planning shares Dispatch's daily plan and edit lease. Requested service
-- windows remain on visits; dispatch scheduling lives on the shared plan/load.
ALTER TABLE mbt_service_visits
  ADD COLUMN IF NOT EXISTS planning_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE driver_job_records
  ADD COLUMN IF NOT EXISTS mbt_assignment_withdrawn_at timestamptz;

-- Dispatch plans start at revision zero. Record their actual revision without
-- changing the positive revision invariant for other MBT entities.
ALTER TABLE mbt_audit_events DROP CONSTRAINT IF EXISTS mbt_audit_events_revision_before_positive;
ALTER TABLE mbt_audit_events ADD CONSTRAINT mbt_audit_events_revision_before_positive
  CHECK (revision_before > 0 OR (revision_before = 0 AND entity_type='dispatch_plan' AND source='mbt-bin-planning'));

CREATE TABLE IF NOT EXISTS mbt_bin_planning_assignments (
  assignment_id uuid PRIMARY KEY,
  service_visit_id uuid NOT NULL REFERENCES mbt_service_visits(service_visit_id),
  generation bigint NOT NULL CHECK (generation > 0),
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id),
  plan_date date NOT NULL,
  load_id text NOT NULL,
  driver_id bigint NOT NULL REFERENCES dispatch_drivers(id),
  truck_id bigint NOT NULL REFERENCES dispatch_trucks(id),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by text,
  withdrawn_at timestamptz,
  withdrawn_by text,
  withdrawal_reason text,
  UNIQUE (service_visit_id, generation),
  CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_bin_planning_assignment_current
  ON mbt_bin_planning_assignments (service_visit_id) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mbt_bin_planning_assignment_driver
  ON mbt_bin_planning_assignments (plan_date, driver_id, service_visit_id)
  WHERE withdrawn_at IS NULL AND released_at IS NOT NULL;

ALTER TABLE mbt_bin_dispatch_assignment_history DROP CONSTRAINT IF EXISTS mbt_bin_dispatch_history_action;
ALTER TABLE mbt_bin_dispatch_assignment_history ADD CONSTRAINT mbt_bin_dispatch_history_action
  CHECK (action IN ('assigned', 'moved', 'recovered', 'advanced', 'cancelled_assignment', 'sequenced', 'load_changed'));

CREATE TABLE IF NOT EXISTS mbt_bin_planning_events (
  event_id uuid PRIMARY KEY,
  service_visit_id uuid NOT NULL REFERENCES mbt_service_visits(service_visit_id),
  action text NOT NULL,
  actor_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mbt_bin_planning_events_visit
  ON mbt_bin_planning_events (service_visit_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mbt_bin_planning_pool
  ON mbt_service_visits (scheduled_start_at, service_visit_id)
  WHERE dispatch_plan_id IS NULL AND status IN ('ready', 'in_progress', 'evidence_pending');

-- Existing completed predecessors also release only their immediate BIN
-- successor. Requested dates and all assignment fields remain untouched.
WITH available AS (
  UPDATE mbt_service_visits successor
  SET status='ready', revision=successor.revision+1, updated_at=now(), updated_by='migration-235'
  FROM mbt_service_visits predecessor
  WHERE predecessor.service_visit_id=successor.predecessor_visit_id
    AND predecessor.status='completed' AND successor.status='tentative'
    AND successor.bin_type_id IS NOT NULL AND successor.dispatch_plan_id IS NULL
    AND successor.contract_id=predecessor.contract_id
    AND successor.service_line_id IS NOT DISTINCT FROM predecessor.service_line_id
    AND NOT EXISTS (SELECT 1 FROM mbt_service_visits peer WHERE peer.contract_id=successor.contract_id
      AND peer.service_line_id IS NOT DISTINCT FROM successor.service_line_id
      AND peer.status IN ('ready','planned','in_progress','evidence_pending'))
  RETURNING successor.service_visit_id, successor.predecessor_visit_id
)
INSERT INTO mbt_bin_planning_events(event_id,service_visit_id,action,actor_id,details)
SELECT gen_random_uuid(),service_visit_id,'available_in_pool','migration-235',
  jsonb_build_object('predecessorVisitId',predecessor_visit_id) FROM available;
