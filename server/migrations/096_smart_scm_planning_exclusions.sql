CREATE TABLE IF NOT EXISTS scm_smart_planning_exclusions (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES inventory_items(item_id) ON DELETE CASCADE,
  reason text NOT NULL,
  expires_at timestamptz,
  created_by text REFERENCES operators(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_by text REFERENCES operators(id) ON DELETE SET NULL,
  deactivated_at timestamptz,
  deactivation_note text,
  CONSTRAINT scm_smart_planning_exclusions_reason_check CHECK (BTRIM(reason) <> ''),
  CONSTRAINT scm_smart_planning_exclusions_deactivation_check CHECK (
    (deactivated_at IS NULL AND deactivated_by IS NULL AND deactivation_note IS NULL)
    OR deactivated_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_smart_planning_exclusions_current_item
  ON scm_smart_planning_exclusions (item_id)
  WHERE deactivated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scm_smart_planning_exclusions_active_lookup
  ON scm_smart_planning_exclusions (item_id, expires_at)
  WHERE deactivated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scm_smart_planning_exclusions_history
  ON scm_smart_planning_exclusions (created_at DESC, id DESC);

COMMENT ON TABLE scm_smart_planning_exclusions IS
  'Temporary item-wide exclusions from future Smart SCM vendor PO generation. Internal TO planning remains available and permanent planning_enabled policy remains unchanged.';

COMMENT ON COLUMN scm_smart_planning_exclusions.expires_at IS
  'When present, the exclusion stops affecting newly generated plans at this instant; its audit history is retained.';
