-- MBT Front Desk multi-bin contract service lines.
--
-- This is an additive local-only seam.  A contract remains the commercial
-- parent, while each physical bin has its own independently dispatchable
-- delivery/return chain.  Existing contracts are given one legacy line so
-- older Front Desk, Dispatch, Driver, and Billing records keep their IDs and
-- behaviour unchanged.

CREATE TABLE IF NOT EXISTS mbt_contract_service_lines (
  service_line_id uuid PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES mbt_contracts(contract_id) ON DELETE RESTRICT,
  source_quote_id uuid REFERENCES mbt_quotes(quote_id) ON DELETE RESTRICT,
  line_number integer NOT NULL,
  bin_type_id uuid NOT NULL REFERENCES mbt_bin_types(bin_type_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'scheduled',
  planned_delivery_at timestamptz,
  planned_return_at timestamptz,
  actual_delivery_completed_at timestamptz,
  actual_collected_at timestamptz,
  pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_confirmation_status text NOT NULL DEFAULT 'not_required',
  customer_confirmation_reason text,
  customer_confirmation_requested_at timestamptz,
  customer_confirmation_confirmed_at timestamptz,
  customer_confirmation_confirmed_by text,
  waiver_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_contract_service_lines_number_positive
    CHECK (line_number > 0),
  CONSTRAINT mbt_contract_service_lines_status
    CHECK (status IN ('scheduled', 'active', 'return_due', 'closed', 'cancelled')),
  CONSTRAINT mbt_contract_service_lines_dates_order
    CHECK (
      planned_delivery_at IS NULL
      OR planned_return_at IS NULL
      OR planned_return_at > planned_delivery_at
    ),
  CONSTRAINT mbt_contract_service_lines_actual_order
    CHECK (
      actual_delivery_completed_at IS NULL
      OR actual_collected_at IS NULL
      OR actual_collected_at >= actual_delivery_completed_at
    ),
  CONSTRAINT mbt_contract_service_lines_pricing_object
    CHECK (jsonb_typeof(pricing_snapshot) = 'object'),
  CONSTRAINT mbt_contract_service_lines_waiver_object
    CHECK (jsonb_typeof(waiver_snapshot) = 'object'),
  CONSTRAINT mbt_contract_service_lines_confirmation_status
    CHECK (customer_confirmation_status IN ('not_required', 'required', 'confirmed', 'declined')),
  CONSTRAINT mbt_contract_service_lines_confirmation_complete
    CHECK (
      customer_confirmation_status NOT IN ('confirmed', 'declined')
      OR (
        customer_confirmation_confirmed_at IS NOT NULL
        AND NULLIF(btrim(COALESCE(customer_confirmation_confirmed_by, '')), '') IS NOT NULL
      )
    ),
  CONSTRAINT mbt_contract_service_lines_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_contract_service_lines_contract_number_unique
    UNIQUE (contract_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_mbt_contract_service_lines_work
  ON mbt_contract_service_lines (contract_id, status, line_number, service_line_id);

ALTER TABLE mbt_service_visits
  ADD COLUMN IF NOT EXISTS service_line_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'mbt_service_visits_service_line_fk'
       AND conrelid = 'mbt_service_visits'::regclass
  ) THEN
    ALTER TABLE mbt_service_visits
      ADD CONSTRAINT mbt_service_visits_service_line_fk
      FOREIGN KEY (service_line_id)
      REFERENCES mbt_contract_service_lines(service_line_id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_mbt_service_visits_service_line
  ON mbt_service_visits (service_line_id, visit_number, service_visit_id)
  WHERE service_line_id IS NOT NULL;

-- Deterministic IDs make this safe to re-run and avoid requiring an extension
-- such as pgcrypto in production migrations.
INSERT INTO mbt_contract_service_lines (
  service_line_id, contract_id, source_quote_id, line_number, bin_type_id,
  status, planned_delivery_at, planned_return_at,
  actual_delivery_completed_at, actual_collected_at,
  pricing_snapshot, customer_confirmation_status, waiver_snapshot,
  revision, created_by, updated_by, created_at, updated_at
)
SELECT
  (
    substr(md5(c.contract_id::text || ':legacy-service-line'), 1, 8) || '-' ||
    substr(md5(c.contract_id::text || ':legacy-service-line'), 9, 4) || '-4' ||
    substr(md5(c.contract_id::text || ':legacy-service-line'), 14, 3) || '-8' ||
    substr(md5(c.contract_id::text || ':legacy-service-line'), 18, 3) || '-' ||
    substr(md5(c.contract_id::text || ':legacy-service-line'), 21, 12)
  )::uuid,
  c.contract_id,
  c.quote_id,
  1,
  c.bin_type_id,
  CASE
    WHEN c.status IN ('closed', 'cancelled') THEN c.status
    WHEN c.actual_delivery_completed_at IS NOT NULL THEN 'active'
    ELSE 'scheduled'
  END,
  c.planned_delivery_at,
  c.planned_return_at,
  c.actual_delivery_completed_at,
  c.actual_closed_at,
  jsonb_build_object('schemaVersion', 'mbt-contract-service-line-v1', 'legacyBackfill', true),
  'not_required',
  '{}'::jsonb,
  1,
  c.created_by,
  c.updated_by,
  c.created_at,
  c.updated_at
FROM mbt_contracts c
WHERE NOT EXISTS (
  SELECT 1 FROM mbt_contract_service_lines line WHERE line.contract_id = c.contract_id
);

-- Completed visits are intentionally immutable.  Existing completed history
-- still needs the new additive relationship, otherwise a legacy contract can
-- lose its completed delivery when Front Desk addresses the remaining return
-- by service-line ID.  Narrow the trigger only inside this migration
-- transaction: the sole permitted change is NULL -> UUID for service_line_id,
-- and every other persisted visit field must remain identical.  The strict
-- function is restored before this migration can commit.
CREATE OR REPLACE FUNCTION mbt_reject_completed_visit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    IF TG_OP = 'UPDATE'
       AND OLD.service_line_id IS NULL
       AND NEW.service_line_id IS NOT NULL
       AND (to_jsonb(NEW) - 'service_line_id') =
           (to_jsonb(OLD) - 'service_line_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'completed service visit % is immutable', OLD.service_visit_id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE mbt_service_visits visit
   SET service_line_id = line.service_line_id
  FROM mbt_contract_service_lines line
 WHERE line.contract_id = visit.contract_id
   AND line.line_number = 1
   AND visit.service_line_id IS NULL;

CREATE OR REPLACE FUNCTION mbt_reject_completed_visit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed service visit % is immutable', OLD.service_visit_id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS mbt_contract_service_line_events (
  service_line_event_id uuid PRIMARY KEY,
  service_line_id uuid NOT NULL REFERENCES mbt_contract_service_lines(service_line_id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES mbt_contracts(contract_id) ON DELETE RESTRICT,
  service_visit_id uuid REFERENCES mbt_service_visits(service_visit_id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  before_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  actor_operator_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_contract_service_line_events_type
    CHECK (event_type IN ('extension', 'exchange', 'collection', 'dispatch_change', 'customer_confirmation', 'charge_waiver')),
  CONSTRAINT mbt_contract_service_line_events_snapshots
    CHECK (jsonb_typeof(before_snapshot) = 'object' AND jsonb_typeof(after_snapshot) = 'object'),
  CONSTRAINT mbt_contract_service_line_events_reason_not_blank
    CHECK (NULLIF(btrim(reason), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_mbt_contract_service_line_events_timeline
  ON mbt_contract_service_line_events (service_line_id, created_at, service_line_event_id);

-- A completed physical delivery/collection moves only that line.  The parent
-- contract closes exactly when its final non-cancelled service line is
-- collected; no Front Desk request can accidentally close a sibling bin.
CREATE OR REPLACE FUNCTION mbt_sync_contract_service_line_terminal_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remaining_lines integer;
BEGIN
  IF NEW.service_line_id IS NULL OR NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;

  IF NEW.service_action = 'delivery' THEN
    UPDATE mbt_contract_service_lines
       SET status = 'active',
           actual_delivery_completed_at = COALESCE(NEW.actual_completed_at, now()),
           revision = revision + 1,
           updated_at = now()
     WHERE service_line_id = NEW.service_line_id
       AND status = 'scheduled';
  ELSIF NEW.service_action IN ('return_bin', 'collection') THEN
    UPDATE mbt_contract_service_lines
       SET status = 'closed',
           actual_collected_at = COALESCE(NEW.actual_completed_at, now()),
           revision = revision + 1,
           updated_at = now()
     WHERE service_line_id = NEW.service_line_id
       AND status <> 'closed';

    SELECT count(*)::int
      INTO remaining_lines
      FROM mbt_contract_service_lines
     WHERE contract_id = NEW.contract_id
       AND status NOT IN ('closed', 'cancelled');

    IF remaining_lines = 0 THEN
      UPDATE mbt_contracts
         SET status = 'closed',
             closed_at = COALESCE(closed_at, NEW.actual_completed_at, now()),
             actual_closed_at = COALESCE(actual_closed_at, NEW.actual_completed_at, now()),
             revision = revision + 1,
             updated_at = now()
       WHERE contract_id = NEW.contract_id
         AND status <> 'closed';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_mbt_sync_contract_service_line_terminal_state
  ON mbt_service_visits;

CREATE TRIGGER trg_mbt_sync_contract_service_line_terminal_state
AFTER INSERT OR UPDATE OF status, actual_completed_at, service_line_id
ON mbt_service_visits
FOR EACH ROW
EXECUTE FUNCTION mbt_sync_contract_service_line_terminal_state();
