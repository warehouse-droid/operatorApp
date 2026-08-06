-- MBT Phase 3.8 current-front-leg Dispatch integration.
--
-- The tables and columns below are additive and scoped to MBT BIN visits. They
-- do not alter the legacy SO/PO/TO/CO plan representation or Driver jobs.

ALTER TABLE mbt_service_visits
  ADD COLUMN IF NOT EXISTS dispatch_load_id text,
  ADD COLUMN IF NOT EXISTS dispatch_assignment_snapshot jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'mbt_service_visits_assignment_snapshot_object'
       AND conrelid = 'mbt_service_visits'::regclass
  ) THEN
    ALTER TABLE mbt_service_visits
      ADD CONSTRAINT mbt_service_visits_assignment_snapshot_object
      CHECK (
        dispatch_assignment_snapshot IS NULL
        OR jsonb_typeof(dispatch_assignment_snapshot) = 'object'
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS mbt_bin_dispatch_assignment_history (
  assignment_history_id uuid PRIMARY KEY,
  service_visit_id uuid NOT NULL
    REFERENCES mbt_service_visits(service_visit_id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL
    REFERENCES mbt_contracts(contract_id) ON DELETE RESTRICT,
  dispatch_plan_id bigint NOT NULL
    REFERENCES dispatch_plans(id) ON DELETE RESTRICT,
  action text NOT NULL,
  prior_assignment jsonb,
  assignment jsonb,
  visit_revision bigint NOT NULL,
  plan_revision bigint NOT NULL,
  actor_operator_id text NOT NULL,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_bin_dispatch_history_action
    CHECK (action IN ('assigned', 'moved', 'recovered', 'advanced')),
  CONSTRAINT mbt_bin_dispatch_history_prior_object
    CHECK (prior_assignment IS NULL OR jsonb_typeof(prior_assignment) = 'object'),
  CONSTRAINT mbt_bin_dispatch_history_assignment_object
    CHECK (assignment IS NULL OR jsonb_typeof(assignment) = 'object'),
  CONSTRAINT mbt_bin_dispatch_history_revisions_positive
    CHECK (visit_revision > 0 AND plan_revision > 0),
  CONSTRAINT mbt_bin_dispatch_history_reason_not_blank
    CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  CONSTRAINT mbt_bin_dispatch_history_command_unique
    UNIQUE (actor_operator_id, action, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mbt_bin_dispatch_history_visit
  ON mbt_bin_dispatch_assignment_history
    (service_visit_id, created_at, assignment_history_id);

CREATE INDEX IF NOT EXISTS idx_mbt_service_visits_dispatch_assignment
  ON mbt_service_visits (dispatch_plan_id, dispatch_load_id, service_visit_id)
  WHERE dispatch_plan_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbt_assert_visit_predecessor_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor_contract_id uuid;
  predecessor_status text;
BEGIN
  IF NEW.predecessor_visit_id IS NULL
     OR NEW.status NOT IN ('ready', 'planned', 'in_progress', 'evidence_pending') THEN
    RETURN NEW;
  END IF;

  SELECT contract_id, status
    INTO predecessor_contract_id, predecessor_status
    FROM mbt_service_visits
   WHERE service_visit_id = NEW.predecessor_visit_id
   FOR KEY SHARE;

  IF predecessor_contract_id IS NULL
     OR predecessor_contract_id <> NEW.contract_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'MBT visit predecessor must belong to the same contract.';
  END IF;

  IF predecessor_status NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'MBT visit predecessor must be terminal before this visit can become current.';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_mbt_service_visits_predecessor_terminal
  ON mbt_service_visits;

CREATE TRIGGER trg_mbt_service_visits_predecessor_terminal
BEFORE INSERT OR UPDATE OF status, predecessor_visit_id, contract_id
ON mbt_service_visits
FOR EACH ROW
EXECUTE FUNCTION mbt_assert_visit_predecessor_terminal();
