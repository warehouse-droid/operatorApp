BEGIN;

INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES
  ('dispatch_netsuite_sales_order_if_3445', false, 'Create a NetSuite Sales Order Item Fulfillment after an accepted Dispatch completion from yard 3445.'),
  ('dispatch_netsuite_sales_order_if_2967', false, 'Create a NetSuite Sales Order Item Fulfillment after an accepted Dispatch completion from yard 2967.'),
  ('dispatch_netsuite_sales_order_if_12441', false, 'Create a NetSuite Sales Order Item Fulfillment after an accepted Dispatch completion from yard 12441.'),
  ('dispatch_netsuite_sales_order_if_150', false, 'Create a NetSuite Sales Order Item Fulfillment after an accepted Dispatch completion from yard 150.')
ON CONFLICT (flag_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS dispatch_sales_order_if_gate_watermarks (
  gate_key text PRIMARY KEY REFERENCES mbt_feature_flags(flag_key) ON DELETE RESTRICT,
  gate_revision bigint NOT NULL CHECK (gate_revision > 0),
  activation_event_id bigint NOT NULL DEFAULT 0 CHECK (activation_event_id >= 0),
  activated_at timestamptz NOT NULL,
  activated_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION dispatch_capture_sales_order_if_activation_watermark()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.flag_key LIKE 'dispatch_netsuite_sales_order_if_%'
     AND NEW.enabled = true
     AND (TG_OP = 'INSERT' OR COALESCE(OLD.enabled, false) = false) THEN
    INSERT INTO dispatch_sales_order_if_gate_watermarks (
      gate_key, gate_revision, activation_event_id,
      activated_at, activated_by, created_at, updated_at
    ) VALUES (
      NEW.flag_key,
      NEW.revision,
      COALESCE((SELECT MAX(id) FROM dispatch_order_completion_events), 0),
      clock_timestamp(),
      COALESCE(NEW.updated_by, ''),
      now(), now()
    )
    ON CONFLICT (gate_key) DO UPDATE SET
      gate_revision = EXCLUDED.gate_revision,
      activation_event_id = EXCLUDED.activation_event_id,
      activated_at = EXCLUDED.activated_at,
      activated_by = EXCLUDED.activated_by,
      updated_at = now();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_dispatch_sales_order_if_activation_watermark ON mbt_feature_flags;
CREATE TRIGGER trg_dispatch_sales_order_if_activation_watermark
  AFTER INSERT OR UPDATE OF enabled ON mbt_feature_flags
  FOR EACH ROW EXECUTE FUNCTION dispatch_capture_sales_order_if_activation_watermark();

CREATE TABLE IF NOT EXISTS dispatch_so_po_allocation_execution_events (
  id bigserial PRIMARY KEY,
  allocation_id bigint NOT NULL REFERENCES dispatch_so_po_allocations(id) ON DELETE RESTRICT,
  phase text NOT NULL CHECK (phase IN ('pickup', 'delivered')),
  driver_job_record_id bigint NOT NULL REFERENCES driver_job_records(id) ON DELETE RESTRICT,
  driver_job_id text NOT NULL,
  plan_id bigint,
  plan_date date,
  load_id text NOT NULL,
  load_name text NOT NULL DEFAULT '',
  stop_id text NOT NULL DEFAULT '',
  sales_order_ref text NOT NULL,
  dispatch_target_ref text NOT NULL,
  po_order_ref text NOT NULL,
  sales_line_id bigint NOT NULL,
  po_line_id bigint NOT NULL,
  allocated_sales_qty numeric NOT NULL CHECK (allocated_sales_qty >= 0),
  allocated_pallet_qty numeric NOT NULL CHECK (allocated_pallet_qty >= 0),
  allocated_layer_qty numeric NOT NULL CHECK (allocated_layer_qty >= 0),
  allocated_section_qty numeric NOT NULL CHECK (allocated_section_qty >= 0),
  allocated_piece_qty numeric NOT NULL CHECK (allocated_piece_qty >= 0),
  allocation_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (allocation_id, phase, driver_job_id),
  CONSTRAINT dispatch_so_po_execution_snapshot_object CHECK (jsonb_typeof(allocation_snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS dispatch_so_po_execution_allocation_idx
  ON dispatch_so_po_allocation_execution_events (allocation_id, phase, plan_id, load_id, created_at);
CREATE INDEX IF NOT EXISTS dispatch_so_po_execution_job_idx
  ON dispatch_so_po_allocation_execution_events (driver_job_id, phase);

DROP TRIGGER IF EXISTS trg_dispatch_so_po_execution_immutable
  ON dispatch_so_po_allocation_execution_events;
CREATE TRIGGER trg_dispatch_so_po_execution_immutable
  BEFORE UPDATE OR DELETE ON dispatch_so_po_allocation_execution_events
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

CREATE OR REPLACE FUNCTION dispatch_normalized_execution_place(raw_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(regexp_replace(btrim(COALESCE(raw_value, '')), '[^a-zA-Z0-9]+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION dispatch_project_so_po_allocation_execution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF lower(btrim(COALESCE(NEW.status, ''))) <> 'complete'
     OR NEW.completed_at IS NULL
     OR jsonb_typeof(COALESCE(NEW.order_refs, '[]'::jsonb)) <> 'array' THEN
    RETURN NEW;
  END IF;

  IF lower(btrim(COALESCE(NEW.stop_type, ''))) = 'pickup' THEN
    INSERT INTO dispatch_so_po_allocation_execution_events (
      allocation_id, phase, driver_job_record_id, driver_job_id,
      plan_id, plan_date, load_id, load_name, stop_id,
      sales_order_ref, dispatch_target_ref, po_order_ref,
      sales_line_id, po_line_id,
      allocated_sales_qty, allocated_pallet_qty, allocated_layer_qty,
      allocated_section_qty, allocated_piece_qty, allocation_snapshot
    )
    SELECT allocation.id, 'pickup', NEW.id, NEW.job_id,
           NEW.plan_id, NEW.plan_date, NEW.load_id, COALESCE(NEW.load_name, ''), COALESCE(NEW.stop_id, ''),
           allocation.sales_order_ref, allocation.dispatch_target_ref, allocation.po_order_ref,
           allocation.sales_line_id, allocation.po_line_id,
           allocation.allocated_sales_qty, allocation.allocated_pallet_qty,
           allocation.allocated_layer_qty, allocation.allocated_section_qty,
           allocation.allocated_piece_qty,
           jsonb_build_object(
             'allocationId', allocation.id,
             'details', allocation.details,
             'salesOrderRef', allocation.sales_order_ref,
             'dispatchTargetRef', allocation.dispatch_target_ref,
             'poOrderRef', allocation.po_order_ref,
             'salesLineId', allocation.sales_line_id,
             'poLineId', allocation.po_line_id,
             'allocatedSalesQty', allocation.allocated_sales_qty,
             'allocatedPalletQty', allocation.allocated_pallet_qty,
             'allocatedLayerQty', allocation.allocated_layer_qty,
             'allocatedSectionQty', allocation.allocated_section_qty,
             'allocatedPieceQty', allocation.allocated_piece_qty
           )
      FROM dispatch_so_po_allocations allocation
     WHERE allocation.status = 'active'
       AND (
         EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(NEW.order_refs) reference(value)
            WHERE lower(btrim(reference.value)) IN (
              lower(btrim(allocation.sales_order_ref)),
              lower(btrim(allocation.dispatch_target_ref)),
              lower(btrim(allocation.po_order_ref))
            )
         )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(COALESCE(NEW.job_details, '{}'::jsonb)->'orders') = 'array'
                 THEN COALESCE(NEW.job_details, '{}'::jsonb)->'orders' ELSE '[]'::jsonb END
             ) retained(value)
            WHERE lower(btrim(COALESCE(retained.value->>'orderRef', ''))) IN (
              lower(btrim(allocation.sales_order_ref)),
              lower(btrim(allocation.dispatch_target_ref)),
              lower(btrim(allocation.po_order_ref))
            )
         )
       )
       AND dispatch_normalized_execution_place(COALESCE(
             NULLIF(NEW.job_details->>'pickupLocation', ''),
             NULLIF(NEW.job_details->>'location', ''),
             NEW.job_details->>'address'
           )) IN (
             dispatch_normalized_execution_place(allocation.details->>'poVendorYard'),
             dispatch_normalized_execution_place(allocation.details->>'poAddress')
           )
    ON CONFLICT (allocation_id, phase, driver_job_id) DO NOTHING;
  ELSIF lower(btrim(COALESCE(NEW.stop_type, ''))) = 'dropoff' THEN
    INSERT INTO dispatch_so_po_allocation_execution_events (
      allocation_id, phase, driver_job_record_id, driver_job_id,
      plan_id, plan_date, load_id, load_name, stop_id,
      sales_order_ref, dispatch_target_ref, po_order_ref,
      sales_line_id, po_line_id,
      allocated_sales_qty, allocated_pallet_qty, allocated_layer_qty,
      allocated_section_qty, allocated_piece_qty, allocation_snapshot
    )
    SELECT allocation.id, 'delivered', NEW.id, NEW.job_id,
           NEW.plan_id, NEW.plan_date, NEW.load_id, COALESCE(NEW.load_name, ''), COALESCE(NEW.stop_id, ''),
           allocation.sales_order_ref, allocation.dispatch_target_ref, allocation.po_order_ref,
           allocation.sales_line_id, allocation.po_line_id,
           allocation.allocated_sales_qty, allocation.allocated_pallet_qty,
           allocation.allocated_layer_qty, allocation.allocated_section_qty,
           allocation.allocated_piece_qty,
           pickup.allocation_snapshot || jsonb_build_object('pickupExecutionEventId', pickup.id)
      FROM dispatch_so_po_allocations allocation
      JOIN dispatch_so_po_allocation_execution_events pickup
        ON pickup.allocation_id = allocation.id
       AND pickup.phase = 'pickup'
       AND pickup.load_id = NEW.load_id
       AND (pickup.plan_id IS NOT DISTINCT FROM NEW.plan_id)
     WHERE allocation.status = 'active'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(NEW.order_refs) reference(value)
          WHERE lower(btrim(reference.value)) IN (
            lower(btrim(allocation.sales_order_ref)),
            lower(btrim(allocation.dispatch_target_ref))
          )
       )
    ON CONFLICT (allocation_id, phase, driver_job_id) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_dispatch_so_po_allocation_execution ON driver_job_records;
CREATE TRIGGER trg_dispatch_so_po_allocation_execution
  AFTER INSERT OR UPDATE ON driver_job_records
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_so_po_allocation_execution();

CREATE TABLE IF NOT EXISTS dispatch_sales_order_if_candidates (
  id uuid PRIMARY KEY,
  completion_event_id bigint NOT NULL UNIQUE
    REFERENCES dispatch_order_completion_events(id) ON DELETE RESTRICT,
  dispatch_order_ref text NOT NULL,
  source_sales_order_id bigint,
  source_sales_order_ref text,
  canonical_location_id bigint,
  gate_key text REFERENCES mbt_feature_flags(flag_key) ON DELETE RESTRICT,
  gate_revision bigint,
  activation_event_id bigint,
  external_id text NOT NULL UNIQUE CHECK (external_id ~ '^MBBS-SOIF-[0-9a-f-]{36}$'),
  snapshot_hash text CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
  line_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  live_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  baseline_transaction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'discovered' CHECK (status IN (
    'discovered', 'historical', 'gate_disabled', 'waiting_evidence',
    'attention', 'queued', 'posting', 'uncertain', 'completed',
    'reconciled', 'closed', 'skipped', 'failed'
  )),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  netsuite_transaction_id bigint,
  netsuite_transaction_ref text,
  last_error text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_action text CHECK (resolution_action IS NULL OR resolution_action IN (
    'automatic', 'recheck', 'snapshot', 'all_live_remaining', 'custom', 'recover', 'skip', 'historical_backfill'
  )),
  resolution_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolution_reason text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT dispatch_sales_order_if_candidate_lease CHECK (
    (status = 'posting' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'posting' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT dispatch_sales_order_if_candidate_completion CHECK (
    (status IN ('completed', 'reconciled') AND completed_at IS NOT NULL)
    OR (status NOT IN ('completed', 'reconciled') AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS dispatch_sales_order_if_candidates_status_idx
  ON dispatch_sales_order_if_candidates (status, created_at, id);
CREATE INDEX IF NOT EXISTS dispatch_sales_order_if_candidates_source_idx
  ON dispatch_sales_order_if_candidates (source_sales_order_id, status, created_at);
CREATE INDEX IF NOT EXISTS dispatch_sales_order_if_candidates_lease_idx
  ON dispatch_sales_order_if_candidates (lease_expires_at, id) WHERE status = 'posting';

CREATE TABLE IF NOT EXISTS dispatch_sales_order_if_line_claims (
  candidate_id uuid NOT NULL REFERENCES dispatch_sales_order_if_candidates(id) ON DELETE CASCADE,
  source_sales_order_id bigint NOT NULL CHECK (source_sales_order_id > 0),
  source_line_id bigint NOT NULL,
  order_line bigint NOT NULL,
  claimed_quantity numeric NOT NULL CHECK (claimed_quantity > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  PRIMARY KEY (candidate_id, source_sales_order_id, source_line_id),
  CHECK ((active = true AND released_at IS NULL) OR (active = false AND released_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS dispatch_sales_order_if_line_claims_active_idx
  ON dispatch_sales_order_if_line_claims (source_sales_order_id, source_line_id)
  WHERE active = true;

CREATE TABLE IF NOT EXISTS dispatch_sales_order_if_attempts (
  id bigserial PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES dispatch_sales_order_if_candidates(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('posting', 'posted', 'recovered', 'uncertain', 'failed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (candidate_id, attempt_number),
  CHECK ((outcome = 'posting' AND finished_at IS NULL) OR (outcome <> 'posting' AND finished_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS dispatch_sales_order_if_audit_events (
  id bigserial PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES dispatch_sales_order_if_candidates(id) ON DELETE RESTRICT,
  action text NOT NULL,
  actor_id text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_dispatch_sales_order_if_audit_immutable
  ON dispatch_sales_order_if_audit_events;
CREATE TRIGGER trg_dispatch_sales_order_if_audit_immutable
  BEFORE UPDATE OR DELETE ON dispatch_sales_order_if_audit_events
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

CREATE OR REPLACE FUNCTION dispatch_enqueue_sales_order_if_candidate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_id uuid;
BEGIN
  IF NEW.order_kind <> 'SO'
     OR NEW.completion_evidence_type NOT IN ('driver_job', 'manual_dispatch') THEN
    RETURN NEW;
  END IF;
  candidate_id := gen_random_uuid();
  INSERT INTO dispatch_sales_order_if_candidates (
    id, completion_event_id, dispatch_order_ref, external_id
  ) VALUES (
    candidate_id, NEW.id, NEW.order_ref, 'MBBS-SOIF-' || candidate_id::text
  )
  ON CONFLICT (completion_event_id) DO NOTHING;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_dispatch_enqueue_sales_order_if_candidate
  ON dispatch_order_completion_events;
CREATE TRIGGER trg_dispatch_enqueue_sales_order_if_candidate
  AFTER INSERT ON dispatch_order_completion_events
  FOR EACH ROW EXECUTE FUNCTION dispatch_enqueue_sales_order_if_candidate();

COMMENT ON TABLE dispatch_so_po_allocation_execution_events IS
  'Immutable allocation-line pickup and customer-delivery evidence for direct PO supply.';
COMMENT ON TABLE dispatch_sales_order_if_candidates IS
  'Durable completion-driven Sales Order Item Fulfillment outbox; no PO/TO transaction is created here.';
COMMENT ON TABLE dispatch_sales_order_if_line_claims IS
  'Serializes split-child fulfillment quantity against each positive NetSuite parent line.';

COMMIT;
