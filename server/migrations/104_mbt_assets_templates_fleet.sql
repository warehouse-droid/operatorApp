-- MBT Phase 1 operational reference data, exact bin-asset ledger, service
-- template foundations, and fail-closed DispatchV2 truck capability.

CREATE TABLE IF NOT EXISTS mbt_yards (
  yard_id uuid PRIMARY KEY,
  yard_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  address_line_1 text NOT NULL DEFAULT '',
  address_line_2 text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  postal_code text NOT NULL DEFAULT '',
  country_code text NOT NULL DEFAULT 'CA',
  timezone text NOT NULL DEFAULT 'America/Toronto',
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_yards_code_not_blank
    CHECK (NULLIF(btrim(yard_code), '') IS NOT NULL),
  CONSTRAINT mbt_yards_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT mbt_yards_country_format
    CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT mbt_yards_coordinates
    CHECK (
      (latitude IS NULL) = (longitude IS NULL)
      AND (latitude IS NULL OR latitude BETWEEN -90 AND 90)
      AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)
    ),
  CONSTRAINT mbt_yards_revision_positive
    CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS mbt_materials (
  material_id uuid PRIMARY KEY,
  material_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_materials_code_not_blank
    CHECK (NULLIF(btrim(material_code), '') IS NOT NULL),
  CONSTRAINT mbt_materials_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT mbt_materials_revision_positive
    CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS mbt_dump_sites (
  dump_site_id uuid PRIMARY KEY,
  dump_site_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  address_line_1 text NOT NULL DEFAULT '',
  address_line_2 text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  postal_code text NOT NULL DEFAULT '',
  country_code text NOT NULL DEFAULT 'CA',
  phone text NOT NULL DEFAULT '',
  operational_notes text NOT NULL DEFAULT '',
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_dump_sites_code_not_blank
    CHECK (NULLIF(btrim(dump_site_code), '') IS NOT NULL),
  CONSTRAINT mbt_dump_sites_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT mbt_dump_sites_country_format
    CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT mbt_dump_sites_coordinates
    CHECK (
      (latitude IS NULL) = (longitude IS NULL)
      AND (latitude IS NULL OR latitude BETWEEN -90 AND 90)
      AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)
    ),
  CONSTRAINT mbt_dump_sites_revision_positive
    CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS mbt_dump_site_materials (
  dump_site_material_id uuid PRIMARY KEY,
  dump_site_id uuid NOT NULL REFERENCES mbt_dump_sites(dump_site_id) ON DELETE RESTRICT,
  material_id uuid NOT NULL REFERENCES mbt_materials(material_id) ON DELETE RESTRICT,
  accepted boolean NOT NULL DEFAULT true,
  scale_ticket_required boolean NOT NULL DEFAULT true,
  operational_notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_dump_site_materials_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_dump_site_materials_site_material_unique
    UNIQUE (dump_site_id, material_id)
);

CREATE TABLE IF NOT EXISTS mbt_bin_types (
  bin_type_id uuid PRIMARY KEY,
  type_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  nominal_yards integer NOT NULL,
  length_mm integer,
  width_mm integer,
  height_mm integer,
  maximum_payload_kg integer,
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_bin_types_code_not_blank
    CHECK (NULLIF(btrim(type_code), '') IS NOT NULL),
  CONSTRAINT mbt_bin_types_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT mbt_bin_types_yards_positive
    CHECK (nominal_yards > 0),
  CONSTRAINT mbt_bin_types_dimensions_positive
    CHECK (
      (length_mm IS NULL OR length_mm > 0)
      AND (width_mm IS NULL OR width_mm > 0)
      AND (height_mm IS NULL OR height_mm > 0)
      AND (maximum_payload_kg IS NULL OR maximum_payload_kg > 0)
    ),
  CONSTRAINT mbt_bin_types_revision_positive
    CHECK (revision > 0)
);

INSERT INTO mbt_bin_types (
  bin_type_id,
  type_code,
  display_name,
  nominal_yards,
  active
)
VALUES
  ('00000000-0000-4000-8000-000000000014', '14YD', '14 yard', 14, true),
  ('00000000-0000-4000-8000-000000000020', '20YD', '20 yard', 20, true),
  ('00000000-0000-4000-8000-000000000030', '30YD', '30 yard', 30, true),
  ('00000000-0000-4000-8000-000000000040', '40YD', '40 yard', 40, true)
ON CONFLICT (type_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS mbt_bin_condition_codes (
  condition_code text PRIMARY KEY,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  serviceable boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_bin_condition_codes_code_not_blank
    CHECK (NULLIF(btrim(condition_code), '') IS NOT NULL),
  CONSTRAINT mbt_bin_condition_codes_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT mbt_bin_condition_codes_revision_positive
    CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS mbt_bin_assets (
  asset_id uuid PRIMARY KEY,
  asset_code text NOT NULL UNIQUE,
  qr_code text,
  barcode text,
  bin_type_id uuid NOT NULL REFERENCES mbt_bin_types(bin_type_id) ON DELETE RESTRICT,
  home_yard_id uuid NOT NULL REFERENCES mbt_yards(yard_id) ON DELETE RESTRICT,
  tare_weight_kg numeric(12, 3),
  condition_code text REFERENCES mbt_bin_condition_codes(condition_code) ON DELETE RESTRICT,
  operational_notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  under_maintenance boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_bin_assets_code_not_blank
    CHECK (NULLIF(btrim(asset_code), '') IS NOT NULL),
  CONSTRAINT mbt_bin_assets_qr_not_blank
    CHECK (qr_code IS NULL OR NULLIF(btrim(qr_code), '') IS NOT NULL),
  CONSTRAINT mbt_bin_assets_barcode_not_blank
    CHECK (barcode IS NULL OR NULLIF(btrim(barcode), '') IS NOT NULL),
  CONSTRAINT mbt_bin_assets_tare_nonnegative
    CHECK (tare_weight_kg IS NULL OR tare_weight_kg >= 0),
  CONSTRAINT mbt_bin_assets_revision_positive
    CHECK (revision > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_bin_assets_qr_unique
  ON mbt_bin_assets (qr_code)
  WHERE qr_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_bin_assets_barcode_unique
  ON mbt_bin_assets (barcode)
  WHERE barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mbt_bin_assets_available_lookup
  ON mbt_bin_assets (bin_type_id, home_yard_id, active, under_maintenance, asset_code);

CREATE TABLE IF NOT EXISTS mbt_bin_movements (
  movement_id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES mbt_bin_assets(asset_id) ON DELETE RESTRICT,
  asset_sequence bigint NOT NULL,
  movement_type text NOT NULL,
  before_status text,
  after_status text NOT NULL,
  before_location_kind text,
  before_location_reference text,
  after_location_kind text NOT NULL,
  after_location_reference text,
  from_yard_id uuid REFERENCES mbt_yards(yard_id) ON DELETE RESTRICT,
  to_yard_id uuid REFERENCES mbt_yards(yard_id) ON DELETE RESTRICT,
  from_customer_site_profile_id uuid REFERENCES mbt_customer_site_profiles(site_profile_id) ON DELETE RESTRICT,
  to_customer_site_profile_id uuid REFERENCES mbt_customer_site_profiles(site_profile_id) ON DELETE RESTRICT,
  from_dump_site_id uuid REFERENCES mbt_dump_sites(dump_site_id) ON DELETE RESTRICT,
  to_dump_site_id uuid REFERENCES mbt_dump_sites(dump_site_id) ON DELETE RESTRICT,
  contract_id uuid,
  service_visit_id uuid,
  truck_id bigint REFERENCES dispatch_trucks(id) ON DELETE RESTRICT,
  driver_id bigint REFERENCES dispatch_drivers(id) ON DELETE RESTRICT,
  evidence_references uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  source text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  override_reason text,
  correction_of_movement_id uuid REFERENCES mbt_bin_movements(movement_id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_bin_movements_sequence_positive
    CHECK (asset_sequence > 0),
  CONSTRAINT mbt_bin_movements_type_not_blank
    CHECK (NULLIF(btrim(movement_type), '') IS NOT NULL),
  CONSTRAINT mbt_bin_movements_before_status
    CHECK (
      before_status IS NULL
      OR before_status IN (
        'available', 'reserved', 'on_truck', 'at_customer', 'at_dump',
        'maintenance', 'lost', 'retired'
      )
    ),
  CONSTRAINT mbt_bin_movements_after_status
    CHECK (
      after_status IN (
        'available', 'reserved', 'on_truck', 'at_customer', 'at_dump',
        'maintenance', 'lost', 'retired'
      )
    ),
  CONSTRAINT mbt_bin_movements_before_location_kind
    CHECK (
      before_location_kind IS NULL
      OR before_location_kind IN ('yard', 'customer_site', 'dump_site', 'truck', 'unknown')
    ),
  CONSTRAINT mbt_bin_movements_after_location_kind
    CHECK (after_location_kind IN ('yard', 'customer_site', 'dump_site', 'truck', 'unknown')),
  CONSTRAINT mbt_bin_movements_source_not_blank
    CHECK (NULLIF(btrim(source), '') IS NOT NULL),
  CONSTRAINT mbt_bin_movements_actor_type_not_blank
    CHECK (NULLIF(btrim(actor_type), '') IS NOT NULL),
  CONSTRAINT mbt_bin_movements_override_reason_not_blank
    CHECK (override_reason IS NULL OR NULLIF(btrim(override_reason), '') IS NOT NULL),
  CONSTRAINT mbt_bin_movements_not_self_correction
    CHECK (correction_of_movement_id IS NULL OR correction_of_movement_id <> movement_id),
  CONSTRAINT mbt_bin_movements_asset_sequence_unique
    UNIQUE (asset_id, asset_sequence),
  CONSTRAINT mbt_bin_movements_asset_movement_unique
    UNIQUE (asset_id, movement_id)
);

CREATE INDEX IF NOT EXISTS idx_mbt_bin_movements_asset_timeline
  ON mbt_bin_movements (asset_id, asset_sequence DESC, movement_id);

CREATE INDEX IF NOT EXISTS idx_mbt_bin_movements_visit
  ON mbt_bin_movements (service_visit_id, occurred_at, movement_id)
  WHERE service_visit_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_mbt_bin_movements_immutable
  ON mbt_bin_movements;
CREATE TRIGGER trg_mbt_bin_movements_immutable
  BEFORE UPDATE OR DELETE ON mbt_bin_movements
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

CREATE TABLE IF NOT EXISTS mbt_bin_asset_state (
  asset_id uuid PRIMARY KEY REFERENCES mbt_bin_assets(asset_id) ON DELETE RESTRICT,
  lifecycle_status text NOT NULL,
  location_kind text NOT NULL,
  location_reference text,
  yard_id uuid REFERENCES mbt_yards(yard_id) ON DELETE RESTRICT,
  customer_site_profile_id uuid REFERENCES mbt_customer_site_profiles(site_profile_id) ON DELETE RESTRICT,
  dump_site_id uuid REFERENCES mbt_dump_sites(dump_site_id) ON DELETE RESTRICT,
  truck_id bigint REFERENCES dispatch_trucks(id) ON DELETE RESTRICT,
  last_movement_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  changed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_bin_asset_state_status
    CHECK (
      lifecycle_status IN (
        'available', 'reserved', 'on_truck', 'at_customer', 'at_dump',
        'maintenance', 'lost', 'retired'
      )
    ),
  CONSTRAINT mbt_bin_asset_state_location_kind
    CHECK (location_kind IN ('yard', 'customer_site', 'dump_site', 'truck', 'unknown')),
  CONSTRAINT mbt_bin_asset_state_location_reference
    CHECK (
      (location_kind = 'yard' AND yard_id IS NOT NULL AND customer_site_profile_id IS NULL AND dump_site_id IS NULL AND truck_id IS NULL)
      OR
      (location_kind = 'customer_site' AND yard_id IS NULL AND customer_site_profile_id IS NOT NULL AND dump_site_id IS NULL AND truck_id IS NULL)
      OR
      (location_kind = 'dump_site' AND yard_id IS NULL AND customer_site_profile_id IS NULL AND dump_site_id IS NOT NULL AND truck_id IS NULL)
      OR
      (location_kind = 'truck' AND yard_id IS NULL AND customer_site_profile_id IS NULL AND dump_site_id IS NULL AND truck_id IS NOT NULL)
      OR
      (location_kind = 'unknown' AND yard_id IS NULL AND customer_site_profile_id IS NULL AND dump_site_id IS NULL AND truck_id IS NULL)
    ),
  CONSTRAINT mbt_bin_asset_state_status_location
    CHECK (
      (lifecycle_status = 'available' AND location_kind = 'yard')
      OR (lifecycle_status = 'reserved' AND location_kind IN ('yard', 'truck'))
      OR (lifecycle_status = 'on_truck' AND location_kind = 'truck')
      OR (lifecycle_status = 'at_customer' AND location_kind = 'customer_site')
      OR (lifecycle_status = 'at_dump' AND location_kind = 'dump_site')
      OR (lifecycle_status = 'maintenance' AND location_kind IN ('yard', 'unknown'))
      OR (lifecycle_status = 'lost' AND location_kind = 'unknown')
      OR (lifecycle_status = 'retired' AND location_kind IN ('yard', 'unknown'))
    ),
  CONSTRAINT mbt_bin_asset_state_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_bin_asset_state_last_movement_fk
    FOREIGN KEY (asset_id, last_movement_id)
    REFERENCES mbt_bin_movements(asset_id, movement_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_mbt_bin_asset_state_dispatch
  ON mbt_bin_asset_state (lifecycle_status, location_kind, yard_id, asset_id);

-- The movement ledger and its materialized state are one invariant. Deferred
-- constraint triggers let the application append a movement and update state
-- in either statement order inside one transaction, while rejecting any
-- direct SQL that commits only one side or points state at a stale movement.
CREATE OR REPLACE FUNCTION mbt_assert_bin_asset_state_matches_latest(p_asset_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  current_state mbt_bin_asset_state%ROWTYPE;
  latest_movement mbt_bin_movements%ROWTYPE;
  expected_truck_id bigint;
BEGIN
  SELECT *
    INTO current_state
    FROM mbt_bin_asset_state
   WHERE asset_id = p_asset_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bin asset % has movement history without materialized state', p_asset_id
      USING ERRCODE = '55000';
  END IF;

  SELECT *
    INTO latest_movement
    FROM mbt_bin_movements
   WHERE asset_id = p_asset_id
   ORDER BY asset_sequence DESC, movement_id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bin asset % has materialized state without movement history', p_asset_id
      USING ERRCODE = '55000';
  END IF;

  expected_truck_id := CASE
    WHEN latest_movement.after_location_kind = 'truck' THEN latest_movement.truck_id
    ELSE NULL
  END;

  IF current_state.last_movement_id IS DISTINCT FROM latest_movement.movement_id
     OR current_state.revision IS DISTINCT FROM latest_movement.asset_sequence
     OR current_state.lifecycle_status IS DISTINCT FROM latest_movement.after_status
     OR current_state.location_kind IS DISTINCT FROM latest_movement.after_location_kind
     OR current_state.location_reference IS DISTINCT FROM latest_movement.after_location_reference
     OR current_state.yard_id IS DISTINCT FROM latest_movement.to_yard_id
     OR current_state.customer_site_profile_id IS DISTINCT FROM latest_movement.to_customer_site_profile_id
     OR current_state.dump_site_id IS DISTINCT FROM latest_movement.to_dump_site_id
     OR current_state.truck_id IS DISTINCT FROM expected_truck_id THEN
    RAISE EXCEPTION 'bin asset state % must exactly match its latest movement %',
      p_asset_id, latest_movement.movement_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION mbt_validate_bin_asset_state_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM mbt_assert_bin_asset_state_matches_latest(OLD.asset_id);
    RETURN OLD;
  END IF;
  PERFORM mbt_assert_bin_asset_state_matches_latest(NEW.asset_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_bin_asset_state_matches_latest
  ON mbt_bin_asset_state;
CREATE CONSTRAINT TRIGGER trg_mbt_bin_asset_state_matches_latest
  AFTER INSERT OR UPDATE OR DELETE ON mbt_bin_asset_state
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_bin_asset_state_constraint();

DROP TRIGGER IF EXISTS trg_mbt_bin_movements_materialized
  ON mbt_bin_movements;
CREATE CONSTRAINT TRIGGER trg_mbt_bin_movements_materialized
  AFTER INSERT ON mbt_bin_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_bin_asset_state_constraint();

CREATE TABLE IF NOT EXISTS mbt_service_templates (
  template_id uuid PRIMARY KEY,
  template_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_service_templates_code_not_blank
    CHECK (NULLIF(btrim(template_code), '') IS NOT NULL),
  CONSTRAINT mbt_service_templates_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT mbt_service_templates_revision_positive
    CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS mbt_service_template_versions (
  template_version_id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES mbt_service_templates(template_id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  required_bin_service boolean NOT NULL DEFAULT true,
  default_rental_calendar_days integer NOT NULL DEFAULT 14,
  billing_ownership text NOT NULL DEFAULT 'customer',
  dump_site_required boolean NOT NULL DEFAULT false,
  effective_from timestamptz,
  effective_to timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_service_template_versions_number_positive
    CHECK (version_number > 0),
  CONSTRAINT mbt_service_template_versions_status
    CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT mbt_service_template_versions_rental_days_positive
    CHECK (default_rental_calendar_days > 0),
  CONSTRAINT mbt_service_template_versions_billing_ownership
    CHECK (billing_ownership IN ('customer', 'mbt', 'mbbs', 'shared', 'none')),
  CONSTRAINT mbt_service_template_versions_effective_order
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT mbt_service_template_versions_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_service_template_versions_template_version_unique
    UNIQUE (template_id, version_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_service_template_versions_active
  ON mbt_service_template_versions (template_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS mbt_service_template_steps (
  template_step_id uuid PRIMARY KEY,
  template_version_id uuid NOT NULL REFERENCES mbt_service_template_versions(template_version_id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL,
  action_code text NOT NULL,
  display_name text NOT NULL,
  stop_kind text NOT NULL,
  location_role text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  required_asset_status_before text,
  required_asset_status_after text,
  billable_leg_to_next boolean NOT NULL DEFAULT false,
  dump_site_required boolean NOT NULL DEFAULT false,
  completion_blocking boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_service_template_steps_sequence_nonnegative
    CHECK (sequence_number >= 0),
  CONSTRAINT mbt_service_template_steps_action_code_format
    CHECK (action_code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT mbt_service_template_steps_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT mbt_service_template_steps_stop_kind_not_blank
    CHECK (NULLIF(btrim(stop_kind), '') IS NOT NULL),
  CONSTRAINT mbt_service_template_steps_location_role_not_blank
    CHECK (NULLIF(btrim(location_role), '') IS NOT NULL),
  CONSTRAINT mbt_service_template_steps_status_before
    CHECK (
      required_asset_status_before IS NULL
      OR required_asset_status_before IN (
        'available', 'reserved', 'on_truck', 'at_customer', 'at_dump',
        'maintenance', 'lost', 'retired'
      )
    ),
  CONSTRAINT mbt_service_template_steps_status_after
    CHECK (
      required_asset_status_after IS NULL
      OR required_asset_status_after IN (
        'available', 'reserved', 'on_truck', 'at_customer', 'at_dump',
        'maintenance', 'lost', 'retired'
      )
    ),
  CONSTRAINT mbt_service_template_steps_sequence_unique
    UNIQUE (template_version_id, sequence_number),
  CONSTRAINT mbt_service_template_steps_action_unique
    UNIQUE (template_version_id, action_code)
);

CREATE TABLE IF NOT EXISTS mbt_service_template_evidence_requirements (
  evidence_requirement_id uuid PRIMARY KEY,
  template_version_id uuid NOT NULL REFERENCES mbt_service_template_versions(template_version_id) ON DELETE RESTRICT,
  template_step_id uuid REFERENCES mbt_service_template_steps(template_step_id) ON DELETE RESTRICT,
  evidence_code text NOT NULL,
  evidence_type text NOT NULL,
  minimum_count integer NOT NULL DEFAULT 1,
  required boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_service_template_evidence_code_format
    CHECK (evidence_code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT mbt_service_template_evidence_type
    CHECK (evidence_type IN ('photo', 'receipt', 'bin_scan', 'weight', 'quantity', 'signature', 'note')),
  CONSTRAINT mbt_service_template_evidence_count_positive
    CHECK (minimum_count > 0),
  CONSTRAINT mbt_service_template_evidence_requirement_unique
    UNIQUE (template_version_id, template_step_id, evidence_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_template_evidence_global_unique
  ON mbt_service_template_evidence_requirements (template_version_id, evidence_code)
  WHERE template_step_id IS NULL;

CREATE OR REPLACE FUNCTION mbt_service_template_version_is_immutable(p_template_version_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  template_status text;
  template_activated_at timestamptz;
  referenced boolean := false;
BEGIN
  SELECT status, activated_at
    INTO template_status, template_activated_at
    FROM mbt_service_template_versions
   WHERE template_version_id = p_template_version_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF template_status <> 'draft' OR template_activated_at IS NOT NULL THEN
    RETURN true;
  END IF;

  -- Migrations create quote/contract/visit consumers after the template
  -- foundation. The guarded query keeps migration 104 independently usable.
  IF to_regclass('public.mbt_service_visits') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM mbt_service_visits
       WHERE service_template_version_id = p_template_version_id
    ) OR EXISTS (
      SELECT 1 FROM mbt_quotes
       WHERE service_template_version_id = p_template_version_id
    ) OR EXISTS (
      SELECT 1 FROM mbt_contracts
       WHERE service_template_version_id = p_template_version_id
    )
      INTO referenced;
  END IF;
  RETURN referenced;
END;
$$;

CREATE OR REPLACE FUNCTION mbt_reject_immutable_service_template_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF mbt_service_template_version_is_immutable(OLD.template_version_id) THEN
    RAISE EXCEPTION 'activated or used service-template version % is immutable',
      OLD.template_version_id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mbt_reject_immutable_service_template_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT'
     AND mbt_service_template_version_is_immutable(OLD.template_version_id) THEN
    RAISE EXCEPTION 'steps and evidence for service-template version % are immutable',
      OLD.template_version_id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'DELETE'
     AND (TG_OP = 'INSERT' OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id)
     AND mbt_service_template_version_is_immutable(NEW.template_version_id) THEN
    RAISE EXCEPTION 'steps and evidence for service-template version % are immutable',
      NEW.template_version_id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_service_template_versions_immutable
  ON mbt_service_template_versions;
CREATE TRIGGER trg_mbt_service_template_versions_immutable
  BEFORE UPDATE OR DELETE ON mbt_service_template_versions
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_service_template_version();

DROP TRIGGER IF EXISTS trg_mbt_service_template_steps_immutable
  ON mbt_service_template_steps;
CREATE TRIGGER trg_mbt_service_template_steps_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON mbt_service_template_steps
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_service_template_child();

DROP TRIGGER IF EXISTS trg_mbt_service_template_evidence_immutable
  ON mbt_service_template_evidence_requirements;
CREATE TRIGGER trg_mbt_service_template_evidence_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON mbt_service_template_evidence_requirements
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_service_template_child();

ALTER TABLE dispatch_trucks
  ADD COLUMN IF NOT EXISTS bin_service_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bin_slot_capacity integer NOT NULL DEFAULT 0;

UPDATE dispatch_trucks
   SET bin_service_enabled = false
 WHERE bin_service_enabled IS NULL;

UPDATE dispatch_trucks
   SET bin_slot_capacity = 0
 WHERE bin_slot_capacity IS NULL;

ALTER TABLE dispatch_trucks
  ALTER COLUMN bin_service_enabled SET DEFAULT false,
  ALTER COLUMN bin_service_enabled SET NOT NULL,
  ALTER COLUMN bin_slot_capacity SET DEFAULT 0,
  ALTER COLUMN bin_slot_capacity SET NOT NULL;

ALTER TABLE dispatch_trucks
  DROP CONSTRAINT IF EXISTS dispatch_trucks_bin_slot_capacity_nonnegative;

ALTER TABLE dispatch_trucks
  ADD CONSTRAINT dispatch_trucks_bin_slot_capacity_nonnegative
  CHECK (bin_slot_capacity >= 0);

CREATE TABLE IF NOT EXISTS dispatch_truck_bin_types (
  truck_id bigint NOT NULL REFERENCES dispatch_trucks(id) ON DELETE RESTRICT,
  bin_type_id uuid NOT NULL REFERENCES mbt_bin_types(bin_type_id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (truck_id, bin_type_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_truck_bin_types_type
  ON dispatch_truck_bin_types (bin_type_id, active, truck_id);

CREATE OR REPLACE FUNCTION mbt_reject_asset_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% assets must be retained and retired', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_bin_assets_retain_history
  ON mbt_bin_assets;
CREATE TRIGGER trg_mbt_bin_assets_retain_history
  BEFORE DELETE ON mbt_bin_assets
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_asset_delete();

COMMENT ON TABLE mbt_bin_assets IS
  'Individual MBT bin assets with immutable UUID identity; lifecycle and physical location are held in mbt_bin_asset_state.';

COMMENT ON TABLE mbt_bin_movements IS
  'Append-only evidence ledger for every MBT bin asset status/location transition and linked correction.';

COMMENT ON COLUMN dispatch_trucks.bin_service_enabled IS
  'Explicit fail-closed capability for BIN work. Existing and newly created trucks default to false.';

COMMENT ON COLUMN dispatch_trucks.bin_slot_capacity IS
  'Maximum simultaneous BIN assets; defaults to zero until explicitly configured.';
