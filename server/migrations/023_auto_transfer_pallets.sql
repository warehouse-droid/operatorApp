ALTER TABLE scm_transfer_dependency_proposals
  ADD COLUMN IF NOT EXISTS calculated_pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pallet_transfer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pallet_calculation_complete boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pallet_qty_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pallet_item_id bigint,
  ADD COLUMN IF NOT EXISTS pallet_item_name text;

ALTER TABLE scm_transfer_dependency_proposals
  DROP CONSTRAINT IF EXISTS scm_transfer_dependency_proposals_status_check;

ALTER TABLE scm_transfer_dependency_proposals
  ADD CONSTRAINT scm_transfer_dependency_proposals_status_check CHECK (
    creation_status IN ('draft', 'creating', 'created', 'failed', 'attention', 'cancelled')
  );

ALTER TABLE order_dependency_lines
  ADD COLUMN IF NOT EXISTS line_role text NOT NULL DEFAULT 'sales_allocation';

ALTER TABLE order_dependency_lines
  ALTER COLUMN sales_line_id DROP NOT NULL;

ALTER TABLE order_dependency_lines
  DROP CONSTRAINT IF EXISTS order_dependency_lines_dependency_id_sales_line_id_item_id_key;

ALTER TABLE order_dependency_lines
  DROP CONSTRAINT IF EXISTS order_dependency_lines_line_role_check;

ALTER TABLE order_dependency_lines
  ADD CONSTRAINT order_dependency_lines_line_role_check CHECK (
    (line_role = 'sales_allocation' AND sales_line_id IS NOT NULL)
    OR line_role = 'pallet'
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_dependency_lines_sales_allocation_unique
  ON order_dependency_lines (dependency_id, sales_line_id, item_id)
  WHERE line_role = 'sales_allocation';

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_dependency_lines_pallet_unique
  ON order_dependency_lines (dependency_id, item_id)
  WHERE line_role = 'pallet';

COMMENT ON COLUMN order_dependency_lines.line_role IS
  'sales_allocation links TO material to an SO line; pallet is an ancillary physical PALLET item generated for transport.';
