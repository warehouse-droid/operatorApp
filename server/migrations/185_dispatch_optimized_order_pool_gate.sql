-- Admin-owned cutover for the indexed Dispatch order pool. The deployment
-- mode may warm and shadow the read model, but cannot expose it until an
-- administrator explicitly enables this default-off gate.

INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES (
  'dispatch_optimized_order_pool',
  false,
  'Serve the indexed and paged Dispatch order pool after shadow verification and read-model readiness'
)
ON CONFLICT (flag_key) DO NOTHING;

-- Readiness is evaluated on the hot Dispatch path. Keep the active-outbox
-- count bounded to an index-only scan even after completed refresh history
-- grows.
CREATE INDEX IF NOT EXISTS idx_dispatch_order_catalog_refresh_active
  ON dispatch_order_catalog_refresh_outbox (status, available_at, id)
  WHERE status IN ('pending', 'failed', 'running');

ALTER TABLE dispatch_order_catalog_state
  ADD COLUMN IF NOT EXISTS shadow_match_count integer NOT NULL DEFAULT 0
    CHECK (shadow_match_count >= 0),
  ADD COLUMN IF NOT EXISTS shadow_mismatch_count integer NOT NULL DEFAULT 0
    CHECK (shadow_mismatch_count >= 0),
  ADD COLUMN IF NOT EXISTS last_shadow_comparison_at timestamptz;
