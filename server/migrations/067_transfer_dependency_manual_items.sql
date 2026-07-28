ALTER TABLE scm_transfer_dependency_proposal_lines
  ADD COLUMN IF NOT EXISTS line_source text NOT NULL DEFAULT 'shortage',
  ADD COLUMN IF NOT EXISTS to_plt numeric,
  ADD COLUMN IF NOT EXISTS to_lyr numeric,
  ADD COLUMN IF NOT EXISTS to_sec numeric,
  ADD COLUMN IF NOT EXISTS to_pcs numeric;

UPDATE scm_transfer_dependency_proposal_lines proposal_line
   SET to_plt = COALESCE(proposal_line.to_plt, GREATEST(COALESCE(sales_line.to_plt, 0), 0)),
       to_lyr = COALESCE(proposal_line.to_lyr, GREATEST(COALESCE(sales_line.to_lyr, 0), 0)),
       to_sec = COALESCE(proposal_line.to_sec, GREATEST(COALESCE(sales_line.to_sec, 0), 0)),
       to_pcs = COALESCE(proposal_line.to_pcs, GREATEST(COALESCE(sales_line.to_pcs, 0), 0))
  FROM sales_order_lines sales_line
 WHERE sales_line.id = proposal_line.sales_line_id;

ALTER TABLE scm_transfer_dependency_proposal_lines
  ALTER COLUMN sales_line_id DROP NOT NULL;

ALTER TABLE scm_transfer_dependency_proposal_lines
  DROP CONSTRAINT IF EXISTS scm_transfer_dependency_proposal_lines_source_check;

ALTER TABLE scm_transfer_dependency_proposal_lines
  ADD CONSTRAINT scm_transfer_dependency_proposal_lines_source_check CHECK (
    (line_source = 'shortage' AND sales_line_id IS NOT NULL)
    OR (line_source = 'manual' AND sales_line_id IS NULL)
  );

ALTER TABLE scm_transfer_dependency_proposal_lines
  DROP CONSTRAINT IF EXISTS scm_transfer_dependency_proposal_lines_conversion_check;

ALTER TABLE scm_transfer_dependency_proposal_lines
  ADD CONSTRAINT scm_transfer_dependency_proposal_lines_conversion_check CHECK (
    COALESCE(to_plt, 0) >= 0
    AND COALESCE(to_lyr, 0) >= 0
    AND COALESCE(to_sec, 0) >= 0
    AND COALESCE(to_pcs, 0) >= 0
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_transfer_dependency_manual_line_item
  ON scm_transfer_dependency_proposal_lines (proposal_id, item_id)
  WHERE line_source = 'manual';

CREATE INDEX IF NOT EXISTS idx_scm_transfer_dependency_proposal_line_source
  ON scm_transfer_dependency_proposal_lines (proposal_id, line_source, id);

ALTER TABLE order_dependency_lines
  DROP CONSTRAINT IF EXISTS order_dependency_lines_line_role_check;

ALTER TABLE order_dependency_lines
  ADD CONSTRAINT order_dependency_lines_line_role_check CHECK (
    (line_role = 'sales_allocation' AND sales_line_id IS NOT NULL)
    OR (line_role IN ('pallet', 'manual_transfer') AND sales_line_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_dependency_lines_manual_transfer_unique
  ON order_dependency_lines (dependency_id, item_id)
  WHERE line_role = 'manual_transfer';

COMMENT ON COLUMN scm_transfer_dependency_proposal_lines.line_source IS
  'shortage links a proposal line to a Sales Order shortage; manual is an operator-added NetSuite inventory item and never reduces SO undercoverage.';

COMMENT ON COLUMN scm_transfer_dependency_proposal_lines.to_plt IS
  'NetSuite conversion snapshot captured when the proposal line is generated or manually added.';

COMMENT ON COLUMN order_dependency_lines.line_role IS
  'sales_allocation links TO material to an SO line; pallet and manual_transfer are ancillary physical transfer items.';
