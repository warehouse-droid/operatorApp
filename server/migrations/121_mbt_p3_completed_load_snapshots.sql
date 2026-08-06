BEGIN;

-- P3.10 freezes the server-normalized completed physical load before any
-- cross-charge calculation. Public commands identify these immutable rows;
-- caller-authored amounts and references never become billing authority.
CREATE TABLE IF NOT EXISTS mbt_mbbs_completed_load_snapshots (
  completed_load_snapshot_id uuid PRIMARY KEY,
  source_system text NOT NULL,
  source_plan_id text NOT NULL,
  source_plan_revision bigint NOT NULL,
  plan_date date NOT NULL,
  physical_load_id text NOT NULL,
  completed_at timestamptz NOT NULL,
  truck_id bigint REFERENCES dispatch_trucks(id) ON DELETE RESTRICT,
  driver_id bigint REFERENCES dispatch_drivers(id) ON DELETE RESTRICT,
  calculated_metres bigint NOT NULL,
  shared_total_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  source_references jsonb NOT NULL,
  source_snapshot jsonb NOT NULL,
  source_snapshot_hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_mbbs_completed_load_source_system
    CHECK (source_system IN ('dispatch', 'migration')),
  CONSTRAINT mbt_mbbs_completed_load_source_identity
    CHECK (
      NULLIF(btrim(source_plan_id), '') IS NOT NULL
      AND source_plan_revision > 0
      AND NULLIF(btrim(physical_load_id), '') IS NOT NULL
    ),
  CONSTRAINT mbt_mbbs_completed_load_amounts_nonnegative
    CHECK (calculated_metres >= 0 AND shared_total_minor >= 0),
  CONSTRAINT mbt_mbbs_completed_load_currency
    CHECK (currency = 'CAD'),
  CONSTRAINT mbt_mbbs_completed_load_references_array
    CHECK (jsonb_typeof(source_references) = 'array' AND jsonb_array_length(source_references) > 0),
  CONSTRAINT mbt_mbbs_completed_load_snapshot_object
    CHECK (jsonb_typeof(source_snapshot) = 'object'),
  CONSTRAINT mbt_mbbs_completed_load_snapshot_hash
    CHECK (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_mbbs_completed_load_actor_not_blank
    CHECK (NULLIF(btrim(created_by), '') IS NOT NULL),
  CONSTRAINT mbt_mbbs_completed_load_source_unique
    UNIQUE (source_system, source_plan_id, source_plan_revision, physical_load_id)
);

CREATE INDEX IF NOT EXISTS idx_mbt_mbbs_completed_load_plan_date
  ON mbt_mbbs_completed_load_snapshots (plan_date, physical_load_id, completed_load_snapshot_id);

DROP TRIGGER IF EXISTS trg_mbt_mbbs_completed_load_snapshots_immutable
  ON mbt_mbbs_completed_load_snapshots;
CREATE TRIGGER trg_mbt_mbbs_completed_load_snapshots_immutable
  BEFORE UPDATE OR DELETE ON mbt_mbbs_completed_load_snapshots
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

-- Activated P3 rate graphs must be able to express a signed discount line.
-- The rate amount remains stored as a non-negative magnitude; the calculator
-- applies the sign from component_kind/line_type deterministically.
ALTER TABLE mbt_rate_components
  DROP CONSTRAINT IF EXISTS mbt_rate_components_kind;
ALTER TABLE mbt_rate_components
  ADD CONSTRAINT mbt_rate_components_kind
    CHECK (
      component_kind IN (
        'base_transport', 'rental', 'extension', 'exchange', 'pickup',
        'downtown_surcharge', 'service', 'discount', 'other'
      )
    ) NOT VALID;

COMMIT;
