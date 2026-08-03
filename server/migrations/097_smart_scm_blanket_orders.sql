ALTER TABLE scm_smart_planning_runs
  ADD COLUMN IF NOT EXISTS plan_kind text NOT NULL DEFAULT 'inventory';

ALTER TABLE scm_smart_planning_runs
  DROP CONSTRAINT IF EXISTS scm_smart_planning_runs_plan_kind_check;

ALTER TABLE scm_smart_planning_runs
  ADD CONSTRAINT scm_smart_planning_runs_plan_kind_check
  CHECK (plan_kind IN ('inventory', 'blanket'));

CREATE INDEX IF NOT EXISTS idx_scm_smart_planning_runs_kind
  ON scm_smart_planning_runs (plan_kind, id DESC);

ALTER TABLE scm_smart_proposals
  ADD COLUMN IF NOT EXISTS proposal_origin text NOT NULL DEFAULT 'inventory',
  ADD COLUMN IF NOT EXISTS blanket_source_po_id bigint REFERENCES purchase_orders(netsuite_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS blanket_source_po_ref text;

ALTER TABLE scm_smart_proposals
  DROP CONSTRAINT IF EXISTS scm_smart_proposals_origin_check;

ALTER TABLE scm_smart_proposals
  ADD CONSTRAINT scm_smart_proposals_origin_check
  CHECK (proposal_origin IN ('inventory', 'blanket'));

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposals_blanket_source
  ON scm_smart_proposals (blanket_source_po_id, status, id DESC)
  WHERE proposal_origin = 'blanket';

CREATE TABLE IF NOT EXISTS scm_smart_blanket_releases (
  id bigserial PRIMARY KEY,
  proposal_id bigint NOT NULL UNIQUE REFERENCES scm_smart_proposals(id) ON DELETE RESTRICT,
  run_id bigint NOT NULL REFERENCES scm_smart_planning_runs(id) ON DELETE RESTRICT,
  source_po_id bigint NOT NULL REFERENCES purchase_orders(netsuite_id) ON DELETE RESTRICT,
  source_po_ref text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'reserved',
  split_id bigint REFERENCES dispatch_scm_po_splits(id) ON DELETE RESTRICT,
  split_po_id bigint REFERENCES purchase_orders(netsuite_id) ON DELETE RESTRICT,
  split_po_ref text,
  ready_date date,
  vendor_reference text,
  packing_number text,
  credit_status text,
  remarks text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  reserved_by text,
  finalized_at timestamptz,
  finalized_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_smart_blanket_releases_status_check CHECK (
    status IN ('reserved', 'partially_released', 'released', 'held', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_blanket_releases_source
  ON scm_smart_blanket_releases (source_po_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_scm_smart_blanket_releases_status
  ON scm_smart_blanket_releases (status, updated_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_smart_blanket_releases_split_ref
  ON scm_smart_blanket_releases (lower(split_po_ref))
  WHERE split_po_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS scm_smart_blanket_allocations (
  id bigserial PRIMARY KEY,
  proposal_id bigint NOT NULL REFERENCES scm_smart_proposals(id) ON DELETE RESTRICT,
  proposal_line_id bigint NOT NULL REFERENCES scm_smart_proposal_lines(id) ON DELETE RESTRICT,
  release_id bigint REFERENCES scm_smart_blanket_releases(id) ON DELETE RESTRICT,
  source_po_id bigint NOT NULL REFERENCES purchase_orders(netsuite_id) ON DELETE RESTRICT,
  source_po_ref text NOT NULL,
  source_line_id bigint NOT NULL REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  item_id bigint NOT NULL,
  destination_location_id bigint NOT NULL,
  destination_name text NOT NULL,
  planned_pallets numeric NOT NULL DEFAULT 0,
  planned_sales_qty numeric NOT NULL DEFAULT 0,
  reserved_pallets numeric NOT NULL DEFAULT 0,
  reserved_sales_qty numeric NOT NULL DEFAULT 0,
  released_pallets numeric NOT NULL DEFAULT 0,
  released_sales_qty numeric NOT NULL DEFAULT 0,
  held_pallets numeric NOT NULL DEFAULT 0,
  held_sales_qty numeric NOT NULL DEFAULT 0,
  cancelled_pallets numeric NOT NULL DEFAULT 0,
  cancelled_sales_qty numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'planned',
  split_line_id bigint REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_line_id, source_line_id),
  CONSTRAINT scm_smart_blanket_allocations_status_check CHECK (
    status IN ('planned', 'reserved', 'released', 'held', 'cancelled')
  ),
  CONSTRAINT scm_smart_blanket_allocations_quantity_check CHECK (
    planned_pallets >= 0 AND planned_sales_qty >= 0
    AND reserved_pallets >= 0 AND reserved_sales_qty >= 0
    AND released_pallets >= 0 AND released_sales_qty >= 0
    AND held_pallets >= 0 AND held_sales_qty >= 0
    AND cancelled_pallets >= 0 AND cancelled_sales_qty >= 0
  ),
  CONSTRAINT scm_smart_blanket_allocations_conservation_check CHECK (
    (
      status = 'planned'
      AND reserved_pallets = 0 AND released_pallets = 0
      AND held_pallets = 0 AND cancelled_pallets = 0
      AND reserved_sales_qty = 0 AND released_sales_qty = 0
      AND held_sales_qty = 0 AND cancelled_sales_qty = 0
    )
    OR (
      status <> 'planned'
      AND ABS(planned_pallets - reserved_pallets - released_pallets - held_pallets - cancelled_pallets) <= 0.000001
      AND ABS(planned_sales_qty - reserved_sales_qty - released_sales_qty - held_sales_qty - cancelled_sales_qty) <= 0.000001
    )
  )
);

ALTER TABLE scm_smart_blanket_allocations
  DROP CONSTRAINT IF EXISTS scm_smart_blanket_allocations_conservation_check;

ALTER TABLE scm_smart_blanket_allocations
  ADD CONSTRAINT scm_smart_blanket_allocations_conservation_check CHECK (
    (
      status = 'planned'
      AND reserved_pallets = 0 AND released_pallets = 0
      AND held_pallets = 0 AND cancelled_pallets = 0
      AND reserved_sales_qty = 0 AND released_sales_qty = 0
      AND held_sales_qty = 0 AND cancelled_sales_qty = 0
    )
    OR (
      status <> 'planned'
      AND ABS(planned_pallets - reserved_pallets - released_pallets - held_pallets - cancelled_pallets) <= 0.000001
      AND ABS(planned_sales_qty - reserved_sales_qty - released_sales_qty - held_sales_qty - cancelled_sales_qty) <= 0.000001
    )
  );

CREATE INDEX IF NOT EXISTS idx_scm_smart_blanket_allocations_pool
  ON scm_smart_blanket_allocations (source_line_id, status, id);

CREATE INDEX IF NOT EXISTS idx_scm_smart_blanket_allocations_release
  ON scm_smart_blanket_allocations (release_id, proposal_line_id, id);

CREATE TABLE IF NOT EXISTS scm_smart_blanket_release_events (
  id bigserial PRIMARY KEY,
  release_id bigint NOT NULL REFERENCES scm_smart_blanket_releases(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  actor text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_smart_blanket_release_events_type_check CHECK (
    event_type IN (
      'reserved', 'reservation_cancelled', 'vendor_finalized', 'split_created',
      'held', 'cancelled', 'alternative_added', 'alternative_removed'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_blanket_release_events_release
  ON scm_smart_blanket_release_events (release_id, id);

COMMENT ON COLUMN scm_smart_planning_runs.plan_kind IS
  'Separates normal inventory planning from blanket-purchase-order pool planning.';

COMMENT ON COLUMN scm_smart_proposals.proposal_origin IS
  'Blanket proposals reuse Smart SCM proposal rendering and vendor replies without entering new-PO execution.';

COMMENT ON TABLE scm_smart_blanket_allocations IS
  'Exact source-PO-line allocation and conservation ledger for blanket-order proposals and releases.';

COMMENT ON TABLE scm_smart_blanket_releases IS
  'Idempotent reservation and final local split history for one confirmed blanket load.';
