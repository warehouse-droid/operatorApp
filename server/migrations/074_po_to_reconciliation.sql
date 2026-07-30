-- Durable PO/TO reconciliation state. NetSuite remains authoritative; this
-- schema preserves every observed snapshot while keeping a separate, mutable
-- current state for fast /POTOschedule reads.

CREATE TABLE IF NOT EXISTS scm_reconciliation_settings (
  singleton_id smallint PRIMARY KEY DEFAULT 1,
  nightly_enabled boolean NOT NULL DEFAULT false,
  nightly_time text NOT NULL DEFAULT '21:30',
  time_zone text NOT NULL DEFAULT 'America/Toronto',
  netsuite_request_concurrency smallint NOT NULL DEFAULT 1,
  yield_to_operational_requests boolean NOT NULL DEFAULT true,
  auto_apply_unambiguous boolean NOT NULL DEFAULT false,
  initial_backfill_modified_since date NOT NULL DEFAULT DATE '2026-01-01',
  initial_dry_run_approved_at timestamptz,
  initial_dry_run_approved_by text,
  last_nightly_local_date date,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_settings_singleton
    CHECK (singleton_id = 1),
  CONSTRAINT scm_reconciliation_settings_nightly_time
    CHECK (nightly_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT scm_reconciliation_settings_concurrency
    CHECK (netsuite_request_concurrency = 1),
  CONSTRAINT scm_reconciliation_settings_initial_approval
    CHECK (
      (initial_dry_run_approved_at IS NULL AND initial_dry_run_approved_by IS NULL)
      OR
      (initial_dry_run_approved_at IS NOT NULL
        AND NULLIF(BTRIM(initial_dry_run_approved_by), '') IS NOT NULL)
    ),
  CONSTRAINT scm_reconciliation_settings_auto_apply
    CHECK (NOT auto_apply_unambiguous OR initial_dry_run_approved_at IS NOT NULL)
);

INSERT INTO scm_reconciliation_settings (singleton_id)
VALUES (1)
ON CONFLICT (singleton_id) DO NOTHING;

COMMENT ON TABLE scm_reconciliation_settings IS
  'Company-wide PO/TO reconciliation schedule. Nightly execution is disabled until the initial dry run is reviewed.';

CREATE TABLE IF NOT EXISTS scm_reconciliation_runs (
  id bigserial PRIMARY KEY,
  run_key text NOT NULL UNIQUE,
  trigger_source text NOT NULL,
  scope_kind text NOT NULL DEFAULT 'all',
  target_order_kind text,
  target_order_netsuite_id bigint,
  target_order_ref text,
  dry_run boolean NOT NULL DEFAULT true,
  apply_unambiguous boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued',
  resume_of_run_id bigint REFERENCES scm_reconciliation_runs(id) ON DELETE RESTRICT,
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  api_request_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_runs_trigger
    CHECK (trigger_source IN ('nightly', 'manual', 'webhook', 'backfill', 'resume')),
  CONSTRAINT scm_reconciliation_runs_scope
    CHECK (scope_kind IN ('all', 'PO', 'TO', 'order_family')),
  CONSTRAINT scm_reconciliation_runs_target_kind
    CHECK (target_order_kind IS NULL OR target_order_kind IN ('PO', 'TO')),
  CONSTRAINT scm_reconciliation_runs_target_id
    CHECK (target_order_netsuite_id IS NULL OR target_order_netsuite_id > 0),
  CONSTRAINT scm_reconciliation_runs_status
    CHECK (status IN (
      'queued', 'running', 'awaiting_approval', 'succeeded',
      'failed', 'cancelled', 'interrupted'
    )),
  CONSTRAINT scm_reconciliation_runs_api_count
    CHECK (api_request_count >= 0),
  CONSTRAINT scm_reconciliation_runs_approval
    CHECK (
      (approved_at IS NULL AND approved_by IS NULL)
      OR
      (approved_at IS NOT NULL AND NULLIF(BTRIM(approved_by), '') IS NOT NULL)
    ),
  CONSTRAINT scm_reconciliation_runs_order_family_target
    CHECK (
      scope_kind <> 'order_family'
      OR (
        target_order_kind IS NOT NULL
        AND (
          target_order_netsuite_id IS NOT NULL
          OR NULLIF(BTRIM(target_order_ref), '') IS NOT NULL
        )
      )
    )
);

-- A single active run protects the four-slot NetSuite account from overlapping
-- nightly, manual, and targeted work.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_reconciliation_runs_one_running
  ON scm_reconciliation_runs ((1))
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_runs_history
  ON scm_reconciliation_runs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_runs_status
  ON scm_reconciliation_runs (status, created_at);

CREATE TABLE IF NOT EXISTS scm_reconciliation_run_targets (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES scm_reconciliation_runs(id) ON DELETE CASCADE,
  order_kind text NOT NULL CHECK (order_kind IN ('PO', 'TO')),
  netsuite_order_id bigint NOT NULL CHECK (netsuite_order_id > 0),
  order_ref text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_change jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_run_targets_status
    CHECK (status IN (
      'pending', 'running', 'succeeded', 'review',
      'skipped', 'failed'
    )),
  CONSTRAINT scm_reconciliation_run_targets_attempts
    CHECK (attempts >= 0),
  UNIQUE (run_id, order_kind, netsuite_order_id)
);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_run_targets_work
  ON scm_reconciliation_run_targets (run_id, status, netsuite_order_id);

CREATE TABLE IF NOT EXISTS scm_reconciliation_audit_events (
  id bigserial PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  run_id bigint REFERENCES scm_reconciliation_runs(id) ON DELETE SET NULL,
  source text NOT NULL,
  event_type text NOT NULL,
  record_type text NOT NULL,
  action text NOT NULL,
  validation_status text NOT NULL DEFAULT 'accepted',
  netsuite_transaction_id bigint,
  transaction_ref text,
  parent_order_kind text,
  parent_order_netsuite_id bigint,
  parent_order_ref text,
  netsuite_line_key text,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_audit_events_source
    CHECK (source IN ('webhook', 'nightly', 'manual', 'backfill', 'system')),
  CONSTRAINT scm_reconciliation_audit_events_record_type
    CHECK (record_type IN ('PO', 'TO', 'IF', 'IR', 'SYSTEM')),
  CONSTRAINT scm_reconciliation_audit_events_validation
    CHECK (validation_status IN ('accepted', 'rejected', 'not_applicable')),
  CONSTRAINT scm_reconciliation_audit_events_transaction_id
    CHECK (netsuite_transaction_id IS NULL OR netsuite_transaction_id > 0),
  CONSTRAINT scm_reconciliation_audit_events_parent_kind
    CHECK (parent_order_kind IS NULL OR parent_order_kind IN ('PO', 'TO')),
  CONSTRAINT scm_reconciliation_audit_events_parent_id
    CHECK (parent_order_netsuite_id IS NULL OR parent_order_netsuite_id > 0),
  CONSTRAINT scm_reconciliation_audit_events_key
    CHECK (NULLIF(BTRIM(event_key), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_audit_events_order
  ON scm_reconciliation_audit_events
    (parent_order_kind, parent_order_netsuite_id, received_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_audit_events_transaction
  ON scm_reconciliation_audit_events
    (record_type, netsuite_transaction_id, received_at DESC, id DESC)
  WHERE netsuite_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_audit_events_run
  ON scm_reconciliation_audit_events (run_id, id)
  WHERE run_id IS NOT NULL;

COMMENT ON TABLE scm_reconciliation_audit_events IS
  'Append-only NetSuite snapshots, dry-run proposals, applied changes, webhook rejections, and reconciliation decisions.';

CREATE OR REPLACE FUNCTION scm_reconciliation_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_scm_reconciliation_audit_events_immutable
  ON scm_reconciliation_audit_events;

CREATE TRIGGER trg_scm_reconciliation_audit_events_immutable
BEFORE UPDATE OR DELETE ON scm_reconciliation_audit_events
FOR EACH ROW EXECUTE FUNCTION scm_reconciliation_reject_audit_mutation();

-- Current IF/IR state is mutable by design. Its latest_event_id always points
-- back to the immutable evidence that produced the current snapshot/tombstone.
CREATE TABLE IF NOT EXISTS scm_reconciliation_transaction_snapshots (
  id bigserial PRIMARY KEY,
  transaction_type text NOT NULL CHECK (transaction_type IN ('IF', 'IR')),
  netsuite_transaction_id bigint NOT NULL CHECK (netsuite_transaction_id > 0),
  transaction_ref text,
  source_order_kind text NOT NULL CHECK (source_order_kind IN ('PO', 'TO')),
  source_order_netsuite_id bigint NOT NULL CHECK (source_order_netsuite_id > 0),
  source_order_ref text,
  status_code text,
  status_text text,
  last_action text NOT NULL DEFAULT 'snapshot'
    CHECK (last_action IN ('create', 'edit', 'delete', 'snapshot')),
  source_location_id bigint,
  source_location text,
  destination_location_id bigint,
  destination_location text,
  actual_location_id bigint,
  actual_location text,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  netsuite_modified_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  latest_event_id bigint NOT NULL
    REFERENCES scm_reconciliation_audit_events(id) ON DELETE RESTRICT,
  payload_hash text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_transaction_snapshots_tombstone
    CHECK (
      (is_deleted = false AND deleted_at IS NULL)
      OR
      (is_deleted = true AND deleted_at IS NOT NULL)
    ),
  UNIQUE (transaction_type, netsuite_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_transaction_snapshots_parent
  ON scm_reconciliation_transaction_snapshots
    (source_order_kind, source_order_netsuite_id, transaction_type, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_transaction_snapshots_active
  ON scm_reconciliation_transaction_snapshots
    (transaction_type, observed_at DESC)
  WHERE is_deleted = false;

CREATE TABLE IF NOT EXISTS scm_reconciliation_transaction_snapshot_lines (
  id bigserial PRIMARY KEY,
  transaction_snapshot_id bigint NOT NULL
    REFERENCES scm_reconciliation_transaction_snapshots(id) ON DELETE CASCADE,
  netsuite_line_key text NOT NULL,
  source_order_line_key text,
  item_id bigint,
  item_name text,
  sku text,
  quantity numeric NOT NULL DEFAULT 0,
  unit text,
  source_location_id bigint,
  destination_location_id bigint,
  actual_location_id bigint,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  latest_event_id bigint NOT NULL
    REFERENCES scm_reconciliation_audit_events(id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_transaction_snapshot_lines_key
    CHECK (NULLIF(BTRIM(netsuite_line_key), '') IS NOT NULL),
  CONSTRAINT scm_reconciliation_transaction_snapshot_lines_tombstone
    CHECK (
      (is_deleted = false AND deleted_at IS NULL)
      OR
      (is_deleted = true AND deleted_at IS NOT NULL)
    ),
  UNIQUE (transaction_snapshot_id, netsuite_line_key)
);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_transaction_lines_source
  ON scm_reconciliation_transaction_snapshot_lines
    (source_order_line_key, transaction_snapshot_id)
  WHERE source_order_line_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_transaction_lines_active
  ON scm_reconciliation_transaction_snapshot_lines
    (transaction_snapshot_id, netsuite_line_key)
  WHERE is_deleted = false;

-- Dispatch currently materializes TO split children as negative transfer_order
-- IDs. This explicit ledger gives reconciliation a stable positive NetSuite
-- parent and exact source-line relationship without relying on SKU matching.
CREATE TABLE IF NOT EXISTS dispatch_scm_to_splits (
  id bigserial PRIMARY KEY,
  source_to_id bigint NOT NULL
    REFERENCES transfer_orders(netsuite_id) ON DELETE CASCADE,
  source_to_ref text NOT NULL,
  split_to_id bigint NOT NULL
    REFERENCES transfer_orders(netsuite_id) ON DELETE CASCADE,
  split_to_ref text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT dispatch_scm_to_splits_source_id CHECK (source_to_id > 0),
  CONSTRAINT dispatch_scm_to_splits_child_id CHECK (split_to_id < 0),
  CONSTRAINT dispatch_scm_to_splits_distinct CHECK (source_to_id <> split_to_id),
  CONSTRAINT dispatch_scm_to_splits_cancelled_at
    CHECK (
      (status = 'active' AND cancelled_at IS NULL)
      OR
      (status = 'cancelled' AND cancelled_at IS NOT NULL)
    ),
  UNIQUE (split_to_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_to_splits_source
  ON dispatch_scm_to_splits (source_to_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS dispatch_scm_to_split_lines (
  id bigserial PRIMARY KEY,
  split_id bigint NOT NULL
    REFERENCES dispatch_scm_to_splits(id) ON DELETE CASCADE,
  source_line_stage text NOT NULL DEFAULT 'outbound',
  source_line_id bigint NOT NULL,
  split_line_stage text NOT NULL DEFAULT 'outbound',
  split_line_id bigint NOT NULL,
  netsuite_source_line_key text,
  item_id bigint,
  sku text,
  item_name text,
  pallet_qty numeric NOT NULL DEFAULT 0,
  layer_qty numeric NOT NULL DEFAULT 0,
  section_qty numeric NOT NULL DEFAULT 0,
  piece_qty numeric NOT NULL DEFAULT 0,
  sales_qty numeric NOT NULL DEFAULT 0,
  requested_pallet_qty numeric NOT NULL DEFAULT 0,
  requested_layer_qty numeric NOT NULL DEFAULT 0,
  requested_section_qty numeric NOT NULL DEFAULT 0,
  requested_piece_qty numeric NOT NULL DEFAULT 0,
  requested_sales_qty numeric NOT NULL DEFAULT 0,
  unit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_scm_to_split_lines_source_fkey
    FOREIGN KEY (source_line_stage, source_line_id)
    REFERENCES transfer_order_lines(line_stage, id) ON DELETE CASCADE,
  CONSTRAINT dispatch_scm_to_split_lines_child_fkey
    FOREIGN KEY (split_line_stage, split_line_id)
    REFERENCES transfer_order_lines(line_stage, id) ON DELETE CASCADE,
  CONSTRAINT dispatch_scm_to_split_lines_stage
    CHECK (source_line_stage = 'outbound' AND split_line_stage = 'outbound'),
  CONSTRAINT dispatch_scm_to_split_lines_quantities
    CHECK (
      pallet_qty >= 0
      AND layer_qty >= 0
      AND section_qty >= 0
      AND piece_qty >= 0
      AND sales_qty >= 0
      AND requested_pallet_qty >= 0
      AND requested_layer_qty >= 0
      AND requested_section_qty >= 0
      AND requested_piece_qty >= 0
      AND requested_sales_qty >= 0
    ),
  UNIQUE (split_id, split_line_stage, split_line_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_to_split_lines_source
  ON dispatch_scm_to_split_lines
    (source_line_stage, source_line_id, split_id);

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_to_split_lines_netsuite_key
  ON dispatch_scm_to_split_lines (netsuite_source_line_key)
  WHERE netsuite_source_line_key IS NOT NULL;

COMMENT ON TABLE dispatch_scm_to_splits IS
  'Stable parent/child ledger for locally materialized Transfer Order splits.';

COMMENT ON COLUMN dispatch_scm_to_split_lines.requested_sales_qty IS
  'Original requested split quantity; sales_qty is the current quantity after source amendments.';

-- Backfill only relationships that can be proven from the existing synthetic
-- split reference and exact NetSuite line_id. Ambiguous rows are deliberately
-- left for Reconcile Review rather than guessed from SKU.
INSERT INTO dispatch_scm_to_splits (
  source_to_id,
  source_to_ref,
  split_to_id,
  split_to_ref,
  status,
  created_at,
  cancelled_at,
  details
)
SELECT
  source_order.netsuite_id,
  source_order.tranid,
  split_order.netsuite_id,
  split_order.tranid,
  CASE WHEN COALESCE(split_order.netsuite_active, true) THEN 'active' ELSE 'cancelled' END,
  COALESCE(split_order.synced_at, now()),
  CASE WHEN COALESCE(split_order.netsuite_active, true) THEN NULL ELSE COALESCE(split_order.synced_at, now()) END,
  jsonb_build_object('backfilled', true, 'matchBasis', 'split-reference')
FROM transfer_orders split_order
JOIN LATERAL (
  SELECT candidate.netsuite_id, candidate.tranid
  FROM transfer_orders candidate
  WHERE candidate.netsuite_id > 0
    AND candidate.tranid = regexp_replace(split_order.tranid, '-S[0-9]+$', '')
  ORDER BY COALESCE(candidate.netsuite_active, true) DESC,
           candidate.netsuite_id DESC
  LIMIT 1
) source_order ON true
WHERE split_order.netsuite_id < 0
  AND split_order.tranid ~ '-S[0-9]+$'
ON CONFLICT DO NOTHING;

INSERT INTO dispatch_scm_to_split_lines (
  split_id,
  source_line_stage,
  source_line_id,
  split_line_stage,
  split_line_id,
  netsuite_source_line_key,
  item_id,
  sku,
  item_name,
  pallet_qty,
  layer_qty,
  section_qty,
  piece_qty,
  sales_qty,
  requested_pallet_qty,
  requested_layer_qty,
  requested_section_qty,
  requested_piece_qty,
  requested_sales_qty,
  unit,
  created_at,
  updated_at
)
SELECT
  split_ledger.id,
  source_line.line_stage,
  source_line.id,
  split_line.line_stage,
  split_line.id,
  source_line.line_id::text,
  split_line.item_id,
  split_line.sku,
  split_line.item_name,
  GREATEST(COALESCE(split_line.pallet_qty, 0), 0),
  GREATEST(COALESCE(split_line.layer_qty, 0), 0),
  GREATEST(COALESCE(split_line.section_qty, 0), 0),
  GREATEST(COALESCE(split_line.piece_qty, 0), 0),
  GREATEST(COALESCE(split_line.quantity, 0), 0),
  GREATEST(COALESCE(split_line.pallet_qty, 0), 0),
  GREATEST(COALESCE(split_line.layer_qty, 0), 0),
  GREATEST(COALESCE(split_line.section_qty, 0), 0),
  GREATEST(COALESCE(split_line.piece_qty, 0), 0),
  GREATEST(COALESCE(split_line.quantity, 0), 0),
  split_line.unit,
  COALESCE(split_line.synced_at, split_ledger.created_at),
  now()
FROM dispatch_scm_to_splits split_ledger
JOIN transfer_order_lines split_line
  ON split_line.transfer_order_id = split_ledger.split_to_id
 AND split_line.line_stage = 'outbound'
 AND split_line.line_id IS NOT NULL
JOIN transfer_order_lines source_line
  ON source_line.transfer_order_id = split_ledger.source_to_id
 AND source_line.line_stage = 'outbound'
 AND source_line.line_id = split_line.line_id
ON CONFLICT (split_id, split_line_stage, split_line_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS scm_reconciliation_order_state (
  id bigserial PRIMARY KEY,
  order_kind text NOT NULL CHECK (order_kind IN ('PO', 'TO')),
  source_order_netsuite_id bigint NOT NULL CHECK (source_order_netsuite_id > 0),
  source_order_ref text NOT NULL,
  netsuite_status_code text,
  netsuite_status_text text,
  netsuite_terminal_state text NOT NULL DEFAULT 'open',
  application_status text NOT NULL DEFAULT 'Queued',
  reconciliation_status text NOT NULL DEFAULT 'pending',
  reconciliation_reason text,
  reconciliation_source text,
  is_recovered boolean NOT NULL DEFAULT false,
  recovered_at timestamptz,
  source_location_id bigint,
  source_location text,
  destination_location_id bigint,
  destination_location text,
  ordered_qty numeric NOT NULL DEFAULT 0,
  fulfilled_qty numeric NOT NULL DEFAULT 0,
  received_qty numeric NOT NULL DEFAULT 0,
  abandoned_qty numeric NOT NULL DEFAULT 0,
  remaining_qty numeric NOT NULL DEFAULT 0,
  destination_remaining_qty numeric NOT NULL DEFAULT 0,
  exact_allocation boolean NOT NULL DEFAULT true,
  missing_success_count integer NOT NULL DEFAULT 0,
  last_direct_lookup_at timestamptz,
  last_netsuite_modified_at timestamptz,
  last_event_id bigint
    REFERENCES scm_reconciliation_audit_events(id) ON DELETE SET NULL,
  last_run_id bigint
    REFERENCES scm_reconciliation_runs(id) ON DELETE SET NULL,
  quantity_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciled_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_order_state_terminal
    CHECK (netsuite_terminal_state IN (
      'open', 'closed', 'cancelled', 'voided', 'missing', 'deleted', 'unknown'
    )),
  CONSTRAINT scm_reconciliation_order_state_application_status
    CHECK (application_status IN (
      'Queued', 'Planned', 'Completed', 'Urgent', 'Cancelled', 'Hold',
      'Priority', 'Surplus Only', 'Book Appt', 'Partially Done',
      'In Transit', 'Reconcile Review'
    )),
  CONSTRAINT scm_reconciliation_order_state_status
    CHECK (reconciliation_status IN ('pending', 'current', 'ok', 'review', 'missing', 'error')),
  CONSTRAINT scm_reconciliation_order_state_source
    CHECK (
      reconciliation_source IS NULL
      OR reconciliation_source IN ('webhook', 'nightly', 'manual', 'backfill', 'system')
    ),
  CONSTRAINT scm_reconciliation_order_state_quantities
    CHECK (
      ordered_qty >= 0
      AND fulfilled_qty >= 0
      AND received_qty >= 0
      AND abandoned_qty >= 0
      AND remaining_qty >= 0
      AND destination_remaining_qty >= 0
    ),
  CONSTRAINT scm_reconciliation_order_state_missing_count
    CHECK (missing_success_count >= 0),
  CONSTRAINT scm_reconciliation_order_state_recovered
    CHECK (
      (is_recovered = false AND recovered_at IS NULL)
      OR
      (is_recovered = true AND recovered_at IS NOT NULL)
    ),
  UNIQUE (order_kind, source_order_netsuite_id)
);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_order_state_ref
  ON scm_reconciliation_order_state (order_kind, lower(source_order_ref));

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_order_state_work
  ON scm_reconciliation_order_state
    (reconciliation_status, application_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS scm_reconciliation_order_line_state (
  id bigserial PRIMARY KEY,
  order_state_id bigint NOT NULL
    REFERENCES scm_reconciliation_order_state(id) ON DELETE CASCADE,
  netsuite_line_key text NOT NULL,
  local_line_id bigint,
  local_line_stage text,
  item_id bigint,
  item_name text,
  sku text,
  unit text,
  source_location_id bigint,
  destination_location_id bigint,
  current_ordered_qty numeric NOT NULL DEFAULT 0,
  fulfilled_qty numeric NOT NULL DEFAULT 0,
  received_qty numeric NOT NULL DEFAULT 0,
  abandoned_qty numeric NOT NULL DEFAULT 0,
  remaining_qty numeric NOT NULL DEFAULT 0,
  line_status text NOT NULL DEFAULT 'open',
  identity_status text NOT NULL DEFAULT 'exact',
  allocation_quality text NOT NULL DEFAULT 'unallocated',
  netsuite_active boolean NOT NULL DEFAULT true,
  last_event_id bigint
    REFERENCES scm_reconciliation_audit_events(id) ON DELETE SET NULL,
  last_run_id bigint
    REFERENCES scm_reconciliation_runs(id) ON DELETE SET NULL,
  line_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_order_line_state_key
    CHECK (NULLIF(BTRIM(netsuite_line_key), '') IS NOT NULL),
  CONSTRAINT scm_reconciliation_order_line_state_quantities
    CHECK (
      current_ordered_qty >= 0
      AND fulfilled_qty >= 0
      AND received_qty >= 0
      AND abandoned_qty >= 0
      AND remaining_qty >= 0
    ),
  CONSTRAINT scm_reconciliation_order_line_state_line_status
    CHECK (line_status IN ('open', 'partial', 'completed', 'cancelled', 'review')),
  CONSTRAINT scm_reconciliation_order_line_state_identity
    CHECK (identity_status IN ('exact', 'missing', 'ambiguous')),
  CONSTRAINT scm_reconciliation_order_line_state_allocation
    CHECK (allocation_quality IN ('unallocated', 'exact', 'inferred', 'pinned', 'mixed')),
  UNIQUE (order_state_id, netsuite_line_key)
);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_order_line_state_order
  ON scm_reconciliation_order_line_state (order_state_id, netsuite_active, id);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_order_line_state_local
  ON scm_reconciliation_order_line_state (local_line_stage, local_line_id)
  WHERE local_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scm_reconciliation_review_cases (
  id bigserial PRIMARY KEY,
  case_key text NOT NULL UNIQUE,
  order_state_id bigint NOT NULL
    REFERENCES scm_reconciliation_order_state(id) ON DELETE RESTRICT,
  order_line_state_id bigint
    REFERENCES scm_reconciliation_order_line_state(id) ON DELETE SET NULL,
  review_code text NOT NULL,
  severity text NOT NULL DEFAULT 'blocking',
  dismissible boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open',
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_run_id bigint
    REFERENCES scm_reconciliation_runs(id) ON DELETE SET NULL,
  detected_event_id bigint
    REFERENCES scm_reconciliation_audit_events(id) ON DELETE SET NULL,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_action text,
  resolution_note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_review_cases_key
    CHECK (NULLIF(BTRIM(case_key), '') IS NOT NULL),
  CONSTRAINT scm_reconciliation_review_cases_code
    CHECK (NULLIF(BTRIM(review_code), '') IS NOT NULL),
  CONSTRAINT scm_reconciliation_review_cases_severity
    CHECK (severity IN ('warning', 'blocking')),
  CONSTRAINT scm_reconciliation_review_cases_dismissible
    CHECK (NOT dismissible OR severity = 'warning'),
  CONSTRAINT scm_reconciliation_review_cases_status
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT scm_reconciliation_review_cases_resolution
    CHECK (
      (
        status = 'open'
        AND resolved_at IS NULL
        AND resolved_by IS NULL
        AND resolution_action IS NULL
        AND resolution_note IS NULL
      )
      OR
      (
        status IN ('resolved', 'dismissed')
        AND resolved_at IS NOT NULL
        AND NULLIF(BTRIM(resolved_by), '') IS NOT NULL
        AND NULLIF(BTRIM(resolution_action), '') IS NOT NULL
        AND NULLIF(BTRIM(resolution_note), '') IS NOT NULL
      )
    ),
  CONSTRAINT scm_reconciliation_review_cases_dismiss
    CHECK (status <> 'dismissed' OR dismissible)
);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_review_cases_open
  ON scm_reconciliation_review_cases
    (order_state_id, severity, first_detected_at, id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_review_cases_history
  ON scm_reconciliation_review_cases
    (status, resolved_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS scm_reconciliation_review_resolutions (
  id bigserial PRIMARY KEY,
  review_case_id bigint NOT NULL
    REFERENCES scm_reconciliation_review_cases(id) ON DELETE RESTRICT,
  action text NOT NULL,
  actor text NOT NULL,
  actor_role text,
  note text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  audit_event_id bigint
    REFERENCES scm_reconciliation_audit_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_review_resolutions_action
    CHECK (action IN (
      'retry', 'allocate', 'accept', 'dismiss', 'auto_resolve', 'reopen'
    )),
  CONSTRAINT scm_reconciliation_review_resolutions_actor
    CHECK (NULLIF(BTRIM(actor), '') IS NOT NULL),
  CONSTRAINT scm_reconciliation_review_resolutions_note
    CHECK (NULLIF(BTRIM(note), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_review_resolutions_case
  ON scm_reconciliation_review_resolutions
    (review_case_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS trg_scm_reconciliation_review_resolutions_immutable
  ON scm_reconciliation_review_resolutions;

CREATE TRIGGER trg_scm_reconciliation_review_resolutions_immutable
BEFORE UPDATE OR DELETE ON scm_reconciliation_review_resolutions
FOR EACH ROW EXECUTE FUNCTION scm_reconciliation_reject_audit_mutation();

CREATE TABLE IF NOT EXISTS scm_reconciliation_allocations (
  id bigserial PRIMARY KEY,
  allocation_key text NOT NULL UNIQUE,
  order_line_state_id bigint NOT NULL
    REFERENCES scm_reconciliation_order_line_state(id) ON DELETE CASCADE,
  progress_kind text NOT NULL CHECK (progress_kind IN ('fulfilled', 'received')),
  target_kind text NOT NULL
    CHECK (target_kind IN ('source_residual', 'po_split', 'to_split')),
  po_split_line_id bigint
    REFERENCES dispatch_scm_po_split_lines(id) ON DELETE CASCADE,
  to_split_line_id bigint
    REFERENCES dispatch_scm_to_split_lines(id) ON DELETE CASCADE,
  target_order_ref text,
  target_line_ref text,
  evidence_transaction_line_id bigint
    REFERENCES scm_reconciliation_transaction_snapshot_lines(id) ON DELETE SET NULL,
  quantity numeric NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  allocation_method text NOT NULL
    CHECK (allocation_method IN ('exact', 'inferred', 'pinned')),
  pin_resolution_id bigint
    REFERENCES scm_reconciliation_review_resolutions(id) ON DELETE RESTRICT,
  pinned_by text,
  pinned_at timestamptz,
  pin_note text,
  active boolean NOT NULL DEFAULT true,
  last_event_id bigint
    REFERENCES scm_reconciliation_audit_events(id) ON DELETE SET NULL,
  last_run_id bigint
    REFERENCES scm_reconciliation_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_reconciliation_allocations_key
    CHECK (NULLIF(BTRIM(allocation_key), '') IS NOT NULL),
  CONSTRAINT scm_reconciliation_allocations_target
    CHECK (
      (
        target_kind = 'source_residual'
        AND po_split_line_id IS NULL
        AND to_split_line_id IS NULL
      )
      OR
      (
        target_kind = 'po_split'
        AND po_split_line_id IS NOT NULL
        AND to_split_line_id IS NULL
      )
      OR
      (
        target_kind = 'to_split'
        AND po_split_line_id IS NULL
        AND to_split_line_id IS NOT NULL
      )
    ),
  CONSTRAINT scm_reconciliation_allocations_pin
    CHECK (
      (
        allocation_method = 'pinned'
        AND pin_resolution_id IS NOT NULL
        AND pinned_at IS NOT NULL
        AND NULLIF(BTRIM(pinned_by), '') IS NOT NULL
        AND NULLIF(BTRIM(pin_note), '') IS NOT NULL
      )
      OR
      (
        allocation_method <> 'pinned'
        AND pin_resolution_id IS NULL
        AND pinned_by IS NULL
        AND pinned_at IS NULL
        AND pin_note IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_allocations_line
  ON scm_reconciliation_allocations
    (order_line_state_id, progress_kind, active, target_kind);

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_allocations_evidence
  ON scm_reconciliation_allocations (evidence_transaction_line_id)
  WHERE evidence_transaction_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_allocations_po_split
  ON scm_reconciliation_allocations (po_split_line_id, progress_kind)
  WHERE po_split_line_id IS NOT NULL AND active = true;

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_allocations_to_split
  ON scm_reconciliation_allocations (to_split_line_id, progress_kind)
  WHERE to_split_line_id IS NOT NULL AND active = true;

CREATE TABLE IF NOT EXISTS scm_reconciliation_user_preferences (
  operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  show_reconciliation_details boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scm_reconciliation_user_preferences IS
  'Per-user display preference. Application authorization limits this setting to SCM and Admin roles.';

-- Reconcile Review is an application lifecycle status, not a parallel manual
-- flag. Existing schedule statuses and data are preserved.
ALTER TABLE scm_transport_schedule
  DROP CONSTRAINT IF EXISTS scm_transport_schedule_status_check;

ALTER TABLE scm_transport_schedule
  ADD CONSTRAINT scm_transport_schedule_status_check
  CHECK (status IN (
    'Queued', 'Planned', 'Completed', 'Urgent', 'Cancelled', 'Hold',
    'Priority', 'Surplus Only', 'Book Appt', 'Partially Done',
    'In Transit', 'Reconcile Review'
  ));

ALTER TABLE scm_transport_schedule
  ADD COLUMN IF NOT EXISTS reconciliation_order_state_id bigint
    REFERENCES scm_reconciliation_order_state(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reconciliation_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_scm_transport_schedule_reconciliation
  ON scm_transport_schedule
    (reconciliation_blocked, reconciliation_order_state_id, last_reconciled_at);

COMMENT ON COLUMN scm_transport_schedule.reconciliation_blocked IS
  'True when an unresolved blocking Reconcile Review case prevents new planning, grouping, splitting, or quantity edits.';
