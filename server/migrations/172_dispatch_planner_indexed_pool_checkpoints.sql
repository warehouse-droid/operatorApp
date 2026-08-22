-- Additive Dispatch planner read/write projections. The feature remains behind
-- server runtime modes; this migration never rewrites active snapshot JSON.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS dispatch_order_catalog_entries (
  order_ref text PRIMARY KEY,
  order_type text NOT NULL,
  eligible boolean NOT NULL DEFAULT true,
  sort_date date,
  sort_key text NOT NULL,
  search_text text NOT NULL,
  card jsonb NOT NULL,
  full_order jsonb NOT NULL,
  source text NOT NULL DEFAULT '',
  source_updated_at timestamptz,
  catalog_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_order_catalog_type_not_blank
    CHECK (NULLIF(btrim(order_type), '') IS NOT NULL),
  CONSTRAINT dispatch_order_catalog_ref_not_blank
    CHECK (NULLIF(btrim(order_ref), '') IS NOT NULL),
  CONSTRAINT dispatch_order_catalog_documents
    CHECK (jsonb_typeof(card) = 'object' AND jsonb_typeof(full_order) = 'object'),
  CONSTRAINT dispatch_order_catalog_revision_positive CHECK (catalog_revision > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_order_catalog_ref_ci
  ON dispatch_order_catalog_entries (lower(order_ref));
CREATE INDEX IF NOT EXISTS idx_dispatch_order_catalog_default_pool
  ON dispatch_order_catalog_entries (order_type, eligible, sort_date NULLS LAST, sort_key, order_ref);
CREATE INDEX IF NOT EXISTS idx_dispatch_order_catalog_search_trgm
  ON dispatch_order_catalog_entries USING gin (search_text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS dispatch_order_catalog_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  status text NOT NULL DEFAULT 'warming',
  generation bigint NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT '',
  catalog_count integer NOT NULL DEFAULT 0,
  legacy_count integer NOT NULL DEFAULT 0,
  assignments_ready boolean NOT NULL DEFAULT false,
  last_full_refresh_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_order_catalog_singleton CHECK (singleton),
  CONSTRAINT dispatch_order_catalog_status CHECK (status IN ('warming', 'ready', 'failed')),
  CONSTRAINT dispatch_order_catalog_generation_nonnegative CHECK (generation >= 0),
  CONSTRAINT dispatch_order_catalog_counts_nonnegative CHECK (catalog_count >= 0 AND legacy_count >= 0)
);

INSERT INTO dispatch_order_catalog_state (singleton, status)
VALUES (true, 'warming')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS dispatch_order_catalog_refresh_outbox (
  id bigserial PRIMARY KEY,
  refresh_key text NOT NULL UNIQUE,
  order_ref text NOT NULL DEFAULT '',
  order_type text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_order_catalog_refresh_status
    CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  CONSTRAINT dispatch_order_catalog_refresh_attempts_nonnegative CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_order_catalog_refresh_pending
  ON dispatch_order_catalog_refresh_outbox (available_at, id)
  WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS dispatch_order_relation_edges (
  id bigserial PRIMARY KEY,
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  owner_ref text NOT NULL,
  member_ref text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  source_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_order_relation_type CHECK (relation_type IN (
    'group_member', 'split_child', 'po_link', 'to_link', 'direct_ship', 'co_source'
  )),
  CONSTRAINT dispatch_order_relation_refs_not_blank CHECK (
    NULLIF(btrim(owner_ref), '') IS NOT NULL AND NULLIF(btrim(member_ref), '') IS NOT NULL
  ),
  CONSTRAINT dispatch_order_relation_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_order_relation_active_edge
  ON dispatch_order_relation_edges (
    COALESCE(plan_id, 0), relation_type, lower(owner_ref), lower(member_ref)
  ) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_dispatch_order_relation_member
  ON dispatch_order_relation_edges (lower(member_ref), relation_type)
  WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_dispatch_order_relation_owner
  ON dispatch_order_relation_edges (lower(owner_ref), relation_type)
  WHERE active = true;

ALTER TABLE dispatch_plan_order_assignments
  ADD COLUMN IF NOT EXISTS planned_order_ref text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS assignment_kind text NOT NULL DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS assignment jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_assignments_hot_lookup
  ON dispatch_plan_order_assignments (lower(order_ref), plan_date, plan_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_plan_assignments_planned_ref
  ON dispatch_plan_order_assignments (plan_id, lower(planned_order_ref));

CREATE TABLE IF NOT EXISTS dispatch_plan_checkpoint_state (
  plan_id bigint PRIMARY KEY REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  last_checkpoint_revision bigint NOT NULL DEFAULT 0,
  last_checkpoint_at timestamptz NOT NULL DEFAULT now(),
  commands_since_checkpoint integer NOT NULL DEFAULT 0,
  checkpoint_due boolean NOT NULL DEFAULT false,
  due_trigger text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_plan_checkpoint_revision_nonnegative CHECK (last_checkpoint_revision >= 0),
  CONSTRAINT dispatch_plan_checkpoint_commands_nonnegative CHECK (commands_since_checkpoint >= 0)
);

ALTER TABLE dispatch_plan_snapshot_history
  ADD COLUMN IF NOT EXISTS checkpoint_kind text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS retention_until timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkpoint_key text NOT NULL DEFAULT '';

UPDATE dispatch_plan_snapshot_history
   SET checkpoint_kind = CASE
         WHEN archive_reason = 'save_recovery' THEN 'recovery'
         WHEN archive_reason LIKE 'manual%' THEN 'manual'
         WHEN archive_reason IN ('before_confirm', 'before_reopen', 'before_restore', 'date_exit', 'edit_release')
           THEN 'lifecycle'
         ELSE 'legacy'
       END
 WHERE checkpoint_kind = 'legacy';

UPDATE dispatch_plan_snapshot_history
   SET retention_until = archived_at + CASE
         WHEN checkpoint_kind IN ('manual', 'lifecycle') THEN interval '90 days'
         WHEN checkpoint_kind = 'recovery' AND resolved_at IS NULL THEN interval '100 years'
         WHEN checkpoint_kind = 'recovery' THEN interval '90 days'
         ELSE interval '7 days'
       END
 WHERE retention_until IS NULL
   AND NOT (checkpoint_kind = 'recovery' AND resolved_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_history_retention
  ON dispatch_plan_snapshot_history (checkpoint_kind, retention_until, archived_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_plan_checkpoint_key
  ON dispatch_plan_snapshot_history (plan_id, checkpoint_kind, checkpoint_key)
  WHERE checkpoint_key <> '';

CREATE TABLE IF NOT EXISTS dispatch_planner_shadow_mismatches (
  id bigserial PRIMARY KEY,
  comparison_kind text NOT NULL,
  request_key text NOT NULL DEFAULT '',
  legacy_digest text NOT NULL,
  optimized_digest text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_planner_shadow_kind CHECK (comparison_kind IN ('order_pool', 'command')),
  CONSTRAINT dispatch_planner_shadow_details_object CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_dispatch_planner_shadow_recent
  ON dispatch_planner_shadow_mismatches (created_at DESC, comparison_kind);
