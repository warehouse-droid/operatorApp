CREATE TABLE IF NOT EXISTS scm_smart_settings (
  id smallint PRIMARY KEY DEFAULT 1,
  execution_mode text NOT NULL DEFAULT 'mock',
  forecast_mode text NOT NULL DEFAULT 'shadow',
  daily_enabled boolean NOT NULL DEFAULT true,
  daily_time text NOT NULL DEFAULT '06:00',
  time_zone text NOT NULL DEFAULT 'America/Toronto',
  vendor_response_sla_hours integer NOT NULL DEFAULT 24,
  truck_capacity_lbs numeric NOT NULL DEFAULT 78000,
  full_load_ratio numeric NOT NULL DEFAULT 0.95,
  hold_load_ratio numeric NOT NULL DEFAULT 0.50,
  model_active_segments jsonb NOT NULL DEFAULT '{}'::jsonb,
  route_matrix jsonb NOT NULL DEFAULT '{"multiStop":[["3445","2967"],["12441","3445","2967"]],"dedicatedOnly":["150"]}'::jsonb,
  last_daily_plan_date date,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_smart_settings_singleton CHECK (id = 1),
  CONSTRAINT scm_smart_settings_execution_mode CHECK (execution_mode IN ('mock', 'live')),
  CONSTRAINT scm_smart_settings_forecast_mode CHECK (forecast_mode IN ('formula', 'shadow', 'hybrid')),
  CONSTRAINT scm_smart_settings_daily_time CHECK (daily_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT scm_smart_settings_sla CHECK (vendor_response_sla_hours BETWEEN 1 AND 720),
  CONSTRAINT scm_smart_settings_truck CHECK (truck_capacity_lbs > 0),
  CONSTRAINT scm_smart_settings_load_ratios CHECK (
    hold_load_ratio > 0 AND hold_load_ratio < full_load_ratio AND full_load_ratio <= 1
  )
);

INSERT INTO scm_smart_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS scm_smart_input_files (
  id bigserial PRIMARY KEY,
  slot text NOT NULL,
  version integer NOT NULL,
  original_filename text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'uploaded',
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT false,
  uploaded_by text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  imported_at timestamptz,
  activated_at timestamptz,
  CONSTRAINT scm_smart_input_files_slot CHECK (
    slot IN ('item_master', 'sales_data', 'decision_workbook', 'decision_tree', 'decision_script')
  ),
  CONSTRAINT scm_smart_input_files_status CHECK (
    status IN ('uploaded', 'validating', 'ready', 'invalid', 'failed')
  ),
  CONSTRAINT scm_smart_input_files_size CHECK (byte_size >= 0),
  UNIQUE (slot, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_smart_input_files_active
  ON scm_smart_input_files (slot)
  WHERE active = true;

CREATE TABLE IF NOT EXISTS scm_smart_item_policies (
  item_id bigint PRIMARY KEY,
  item_name text NOT NULL,
  item_description text,
  vendor text,
  vendor_code text,
  series text,
  stock_unit text,
  to_plt numeric,
  to_lyr numeric,
  to_sec numeric,
  to_pcs numeric,
  lead_time_days numeric,
  plant text,
  pallet_weight_lbs numeric,
  inventory_turnover numeric,
  average_soh_days numeric,
  velocity_class text,
  purchase_lead_time_days numeric,
  safety_stock_level numeric,
  safety_stock_days numeric,
  seasonal_demand text,
  expected_demand_change numeric,
  inactive boolean NOT NULL DEFAULT false,
  discontinued boolean NOT NULL DEFAULT false,
  source_input_file_id bigint REFERENCES scm_smart_input_files(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_item_policies_planning
  ON scm_smart_item_policies (plant, vendor, inactive, discontinued);

CREATE TABLE IF NOT EXISTS scm_smart_item_yard_policies (
  item_id bigint NOT NULL REFERENCES scm_smart_item_policies(item_id) ON DELETE CASCADE,
  location_id bigint NOT NULL,
  yard_code text NOT NULL,
  eligible boolean NOT NULL DEFAULT false,
  capacity_pallets numeric NOT NULL DEFAULT 25,
  service_quantile numeric NOT NULL DEFAULT 0.90,
  minimum_safety_pallets numeric NOT NULL DEFAULT 1,
  source_input_file_id bigint REFERENCES scm_smart_input_files(id) ON DELETE SET NULL,
  manually_overridden boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, location_id),
  CONSTRAINT scm_smart_item_yard_capacity CHECK (capacity_pallets >= 0),
  CONSTRAINT scm_smart_item_yard_quantile CHECK (service_quantile > 0.5 AND service_quantile < 1),
  CONSTRAINT scm_smart_item_yard_safety CHECK (minimum_safety_pallets >= 0)
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_item_yard_eligible
  ON scm_smart_item_yard_policies (location_id, eligible, item_id);

CREATE TABLE IF NOT EXISTS scm_smart_sales_facts (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  source_key text NOT NULL UNIQUE,
  transaction_date date NOT NULL,
  document_ref text,
  item_id bigint NOT NULL,
  item_name text,
  quantity numeric NOT NULL,
  delivery_method text,
  location_id bigint,
  yard_code text,
  sales_amount numeric,
  source_input_file_id bigint REFERENCES scm_smart_input_files(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_sales_facts_series
  ON scm_smart_sales_facts (item_id, location_id, transaction_date);

CREATE INDEX IF NOT EXISTS idx_scm_smart_sales_facts_document
  ON scm_smart_sales_facts (document_ref, item_id);

CREATE TABLE IF NOT EXISTS scm_smart_vendor_supply (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL,
  vendor text,
  plant text,
  status text NOT NULL DEFAULT 'unknown',
  available_pallets numeric,
  production_eta date,
  vendor_reference text,
  remarks text,
  source text NOT NULL DEFAULT 'import',
  source_input_file_id bigint REFERENCES scm_smart_input_files(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CONSTRAINT scm_smart_vendor_supply_status CHECK (
    status IN ('unknown', 'available', 'partial', 'out_of_stock', 'production_eta', 'credit_hold')
  )
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_vendor_supply_latest
  ON scm_smart_vendor_supply (item_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS scm_smart_forecast_runs (
  id bigserial PRIMARY KEY,
  status text NOT NULL DEFAULT 'running',
  trigger_source text NOT NULL DEFAULT 'manual',
  model_version text NOT NULL DEFAULT 'hybrid-statistical-v1',
  data_cutoff date,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT scm_smart_forecast_runs_status CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS scm_smart_forecasts (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES scm_smart_forecast_runs(id) ON DELETE CASCADE,
  item_id bigint NOT NULL,
  location_id bigint NOT NULL,
  yard_code text NOT NULL,
  selected_model text NOT NULL,
  authoritative_model text NOT NULL DEFAULT 'formula',
  confidence text NOT NULL DEFAULT 'low',
  history_weeks integer NOT NULL DEFAULT 0,
  positive_weeks integer NOT NULL DEFAULT 0,
  baseline_weekly numeric NOT NULL DEFAULT 0,
  p50_weekly numeric NOT NULL DEFAULT 0,
  p75_weekly numeric NOT NULL DEFAULT 0,
  p90_weekly numeric NOT NULL DEFAULT 0,
  p95_weekly numeric NOT NULL DEFAULT 0,
  lead_time_p50 numeric NOT NULL DEFAULT 0,
  lead_time_p75 numeric NOT NULL DEFAULT 0,
  lead_time_p90 numeric NOT NULL DEFAULT 0,
  lead_time_p95 numeric NOT NULL DEFAULT 0,
  wape numeric,
  bias numeric,
  eligible_for_promotion boolean NOT NULL DEFAULT false,
  drivers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, item_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_forecasts_lookup
  ON scm_smart_forecasts (item_id, location_id, run_id DESC);

CREATE TABLE IF NOT EXISTS scm_smart_planning_runs (
  id bigserial PRIMARY KEY,
  status text NOT NULL DEFAULT 'running',
  trigger_source text NOT NULL DEFAULT 'manual',
  forecast_run_id bigint REFERENCES scm_smart_forecast_runs(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1,
  settings_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT scm_smart_planning_runs_status CHECK (
    status IN ('running', 'ready', 'failed', 'superseded', 'completed')
  )
);

CREATE TABLE IF NOT EXISTS scm_smart_proposals (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES scm_smart_planning_runs(id) ON DELETE CASCADE,
  proposal_key text NOT NULL,
  proposal_type text NOT NULL,
  phase text NOT NULL,
  source_kind text NOT NULL,
  source_location_id bigint,
  source_name text,
  destination_location_id bigint NOT NULL,
  destination_name text NOT NULL,
  vendor text,
  plant text,
  status text NOT NULL DEFAULT 'draft',
  urgent boolean NOT NULL DEFAULT false,
  provisional boolean NOT NULL DEFAULT false,
  total_pallets numeric NOT NULL DEFAULT 0,
  total_weight_lbs numeric NOT NULL DEFAULT 0,
  utilization numeric NOT NULL DEFAULT 0,
  vendor_reply_due_at timestamptz,
  memo text,
  execution_mode text,
  execution_status text,
  execution_error text,
  netsuite_transfer_order_id bigint,
  netsuite_transfer_order_ref text,
  approved_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by text,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_smart_proposals_type CHECK (proposal_type IN ('PO', 'TO')),
  CONSTRAINT scm_smart_proposals_phase CHECK (
    phase IN ('direct_vendor', 'internal_transfer', 'vendor_hub', 'hub_store')
  ),
  CONSTRAINT scm_smart_proposals_source CHECK (source_kind IN ('vendor', 'yard')),
  CONSTRAINT scm_smart_proposals_status CHECK (
    status IN ('draft', 'held', 'awaiting_vendor', 'reviewed', 'confirmed', 'executing', 'completed', 'failed', 'superseded', 'cancelled', 'attention')
  ),
  UNIQUE (run_id, proposal_key)
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposals_run
  ON scm_smart_proposals (run_id, status, phase, id);

CREATE TABLE IF NOT EXISTS scm_smart_proposal_lines (
  id bigserial PRIMARY KEY,
  proposal_id bigint NOT NULL REFERENCES scm_smart_proposals(id) ON DELETE CASCADE,
  item_id bigint NOT NULL,
  item_name text NOT NULL,
  item_description text,
  unit text,
  required_pallets numeric NOT NULL DEFAULT 0,
  proposed_pallets numeric NOT NULL DEFAULT 0,
  confirmed_pallets numeric NOT NULL DEFAULT 0,
  residual_pallets numeric NOT NULL DEFAULT 0,
  sales_quantity numeric NOT NULL DEFAULT 0,
  pallet_weight_lbs numeric,
  line_weight_lbs numeric NOT NULL DEFAULT 0,
  to_plt numeric,
  to_lyr numeric,
  to_sec numeric,
  to_pcs numeric,
  manual_planning_required boolean NOT NULL DEFAULT false,
  reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposal_lines_item
  ON scm_smart_proposal_lines (item_id, proposal_id);

CREATE TABLE IF NOT EXISTS scm_smart_vendor_responses (
  id bigserial PRIMARY KEY,
  proposal_line_id bigint NOT NULL REFERENCES scm_smart_proposal_lines(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  response_status text NOT NULL,
  confirmed_pallets numeric NOT NULL DEFAULT 0,
  unavailable_pallets numeric NOT NULL DEFAULT 0,
  ready_date date,
  vendor_reference text,
  netsuite_po_reference text,
  packing_number text,
  credit_status text,
  remarks text,
  response_source text NOT NULL DEFAULT 'grid',
  responded_by text,
  responded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_smart_vendor_responses_status CHECK (
    response_status IN ('awaiting', 'confirmed', 'partial', 'out_of_stock', 'production_eta', 'credit_hold', 'cancelled')
  ),
  UNIQUE (proposal_line_id, revision)
);

CREATE TABLE IF NOT EXISTS scm_smart_plan_revisions (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES scm_smart_planning_runs(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  reason text NOT NULL,
  before_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, revision)
);

CREATE TABLE IF NOT EXISTS scm_smart_inventory_reservations (
  id bigserial PRIMARY KEY,
  proposal_line_id bigint NOT NULL UNIQUE REFERENCES scm_smart_proposal_lines(id) ON DELETE CASCADE,
  item_id bigint NOT NULL,
  source_location_id bigint NOT NULL,
  destination_location_id bigint NOT NULL,
  reserved_sales_quantity numeric NOT NULL DEFAULT 0,
  reserved_pallets numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  netsuite_transfer_order_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_smart_reservations_status CHECK (status IN ('active', 'executed', 'released'))
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_reservations_inventory
  ON scm_smart_inventory_reservations (item_id, source_location_id, status);

CREATE TABLE IF NOT EXISTS scm_yard_printers (
  location_id bigint PRIMARY KEY,
  yard_code text NOT NULL UNIQUE,
  printer_name text NOT NULL DEFAULT '',
  agent_id text NOT NULL UNIQUE,
  agent_token_hash text,
  enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'not_configured',
  last_seen_at timestamptz,
  last_error text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_yard_printers_status CHECK (
    status IN ('not_configured', 'offline', 'online', 'error', 'disabled')
  )
);

INSERT INTO scm_yard_printers (location_id, yard_code, agent_id)
VALUES
  (1, '3445', 'yard-3445'),
  (28, '2967', 'yard-2967'),
  (15, '12441', 'yard-12441'),
  (26, '150', 'yard-150')
ON CONFLICT (location_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS scm_print_jobs (
  id bigserial PRIMARY KEY,
  job_key text NOT NULL UNIQUE,
  proposal_id bigint REFERENCES scm_smart_proposals(id) ON DELETE SET NULL,
  location_id bigint NOT NULL REFERENCES scm_yard_printers(location_id) ON DELETE RESTRICT,
  document_type text NOT NULL DEFAULT 'picking_ticket',
  document_name text NOT NULL,
  document_path text NOT NULL,
  document_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  lease_token_hash text,
  lease_expires_at timestamptz,
  leased_by text,
  last_error text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  printed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_print_jobs_status CHECK (
    status IN ('queued', 'leased', 'printing', 'printed', 'failed', 'uncertain', 'cancelled')
  ),
  CONSTRAINT scm_print_jobs_attempts CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_scm_print_jobs_queue
  ON scm_print_jobs (location_id, status, queued_at);

COMMENT ON TABLE scm_smart_planning_runs IS
  'Versioned, isolated Smart SCM replenishment calculations. Existing SO Auto Transfer batches are intentionally separate.';

COMMENT ON TABLE scm_yard_printers IS
  'Per-yard outbound Windows print agents and native printer names used by Smart SCM picking-ticket jobs.';
