-- Extend the existing reconciliation run ledger to Sales Orders while keeping
-- PO/TO IF/IR state isolated. SOs use their authoritative header and lines.

ALTER TABLE scm_reconciliation_settings
  ADD COLUMN IF NOT EXISTS so_initial_dry_run_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS so_initial_dry_run_approved_by text;

ALTER TABLE scm_reconciliation_settings
  DROP CONSTRAINT IF EXISTS scm_reconciliation_settings_so_initial_approval,
  ADD CONSTRAINT scm_reconciliation_settings_so_initial_approval
    CHECK (
      (so_initial_dry_run_approved_at IS NULL AND so_initial_dry_run_approved_by IS NULL)
      OR
      (so_initial_dry_run_approved_at IS NOT NULL
        AND NULLIF(BTRIM(so_initial_dry_run_approved_by), '') IS NOT NULL)
    );

ALTER TABLE scm_reconciliation_runs
  DROP CONSTRAINT IF EXISTS scm_reconciliation_runs_scope,
  ADD CONSTRAINT scm_reconciliation_runs_scope
    CHECK (scope_kind IN ('all', 'SO', 'PO', 'TO', 'order_family')),
  DROP CONSTRAINT IF EXISTS scm_reconciliation_runs_target_kind,
  ADD CONSTRAINT scm_reconciliation_runs_target_kind
    CHECK (target_order_kind IS NULL OR target_order_kind IN ('SO', 'PO', 'TO'));

ALTER TABLE scm_reconciliation_run_targets
  DROP CONSTRAINT IF EXISTS scm_reconciliation_run_targets_order_kind_check,
  ADD CONSTRAINT scm_reconciliation_run_targets_order_kind_check
    CHECK (order_kind IN ('SO', 'PO', 'TO'));

ALTER TABLE scm_reconciliation_audit_events
  DROP CONSTRAINT IF EXISTS scm_reconciliation_audit_events_record_type,
  ADD CONSTRAINT scm_reconciliation_audit_events_record_type
    CHECK (record_type IN ('SO', 'PO', 'TO', 'IF', 'IR', 'SYSTEM')),
  DROP CONSTRAINT IF EXISTS scm_reconciliation_audit_events_parent_kind,
  ADD CONSTRAINT scm_reconciliation_audit_events_parent_kind
    CHECK (parent_order_kind IS NULL OR parent_order_kind IN ('SO', 'PO', 'TO'));

CREATE TABLE IF NOT EXISTS dispatch_scm_so_splits (
  id bigserial PRIMARY KEY,
  source_so_id bigint NOT NULL
    REFERENCES sales_orders(netsuite_id) ON DELETE CASCADE,
  source_so_ref text NOT NULL,
  split_so_id bigint NOT NULL
    REFERENCES sales_orders(netsuite_id) ON DELETE CASCADE,
  split_so_ref text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT dispatch_scm_so_splits_source_id CHECK (source_so_id > 0),
  CONSTRAINT dispatch_scm_so_splits_child_id CHECK (split_so_id < 0),
  CONSTRAINT dispatch_scm_so_splits_distinct CHECK (source_so_id <> split_so_id),
  CONSTRAINT dispatch_scm_so_splits_cancelled_at CHECK (
    (status = 'active' AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
  ),
  UNIQUE (split_so_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_so_splits_source
  ON dispatch_scm_so_splits (source_so_id, status, created_at, id);

INSERT INTO dispatch_scm_so_splits (
  source_so_id, source_so_ref, split_so_id, split_so_ref,
  status, created_at, cancelled_at, details
)
SELECT parent.netsuite_id,
       parent.tranid,
       split.netsuite_id,
       split.tranid,
       CASE WHEN COALESCE(split.netsuite_active, true) THEN 'active' ELSE 'cancelled' END,
       COALESCE(split.synced_at, now()),
       CASE WHEN COALESCE(split.netsuite_active, true)
         THEN NULL ELSE COALESCE(split.synced_at, now()) END,
       jsonb_build_object('backfilled', true, 'matchBasis', 'split-reference')
  FROM sales_orders split
  JOIN sales_orders parent
    ON parent.netsuite_id > 0
   AND upper(parent.tranid) = upper(regexp_replace(split.tranid, '-S[0-9]+$', '', 'i'))
 WHERE split.netsuite_id < 0
   AND split.tranid ~* '-S[0-9]+$'
ON CONFLICT (split_so_ref) DO NOTHING;

COMMENT ON TABLE dispatch_scm_so_splits IS
  'Durable positive NetSuite Sales Order parent identity for local dispatch split children.';
