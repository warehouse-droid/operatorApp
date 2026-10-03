-- NULL means the old count did not capture packing; never invent a historic 0.
ALTER TABLE inventory_count_sheet_counts
  ADD COLUMN IF NOT EXISTS packed_qty numeric,
  ADD COLUMN IF NOT EXISTS actual_on_hand numeric,
  ADD COLUMN IF NOT EXISTS packed_snapshot_at timestamptz,
  ADD COLUMN IF NOT EXISTS comparison_basis text NOT NULL DEFAULT 'confirmation';

ALTER TABLE cycle_count_lines
  ADD COLUMN IF NOT EXISTS system_packed_qty numeric,
  ADD COLUMN IF NOT EXISTS actual_on_hand_qty numeric,
  ADD COLUMN IF NOT EXISTS packed_snapshot_at timestamptz;

-- System maintenance must not impersonate the operator who performed the count.
ALTER TABLE inventory_count_sheet_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE inventory_count_sheet_events ADD CONSTRAINT count_sheet_event_actor_required
  CHECK (actor_id IS NOT NULL OR action='comparison_reconstructed');
