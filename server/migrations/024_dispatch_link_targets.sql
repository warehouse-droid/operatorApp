ALTER TABLE order_dependencies
  ADD COLUMN IF NOT EXISTS dispatch_target_ref text,
  ADD COLUMN IF NOT EXISTS dispatch_target_kind text NOT NULL DEFAULT 'normal';

UPDATE order_dependencies
   SET dispatch_target_ref = sales_order_ref
 WHERE dispatch_target_ref IS NULL OR btrim(dispatch_target_ref) = '';

ALTER TABLE order_dependencies
  ALTER COLUMN dispatch_target_ref SET NOT NULL;

ALTER TABLE order_dependencies
  DROP CONSTRAINT IF EXISTS order_dependencies_dispatch_target_kind_check;

ALTER TABLE order_dependencies
  ADD CONSTRAINT order_dependencies_dispatch_target_kind_check CHECK (
    dispatch_target_kind IN ('normal', 'split', 'group')
  );

CREATE INDEX IF NOT EXISTS idx_order_dependencies_dispatch_target
  ON order_dependencies (dispatch_target_ref, status, dependency_mode);

ALTER TABLE order_dependency_lines
  ADD COLUMN IF NOT EXISTS dispatch_target_line_key text;

UPDATE order_dependency_lines line
   SET dispatch_target_line_key = dependency.dispatch_target_ref || '::' || dependency.sales_order_ref || '::' || line.sales_line_id::text
  FROM order_dependencies dependency
 WHERE dependency.id = line.dependency_id
   AND line.line_role = 'sales_allocation'
   AND (line.dispatch_target_line_key IS NULL OR btrim(line.dispatch_target_line_key) = '');

DROP INDEX IF EXISTS idx_order_dependency_lines_sales_allocation_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_dependency_lines_target_key
  ON order_dependency_lines (dependency_id, dispatch_target_line_key)
  WHERE line_role = 'sales_allocation';

ALTER TABLE dispatch_so_po_allocations
  ADD COLUMN IF NOT EXISTS dispatch_target_ref text,
  ADD COLUMN IF NOT EXISTS dispatch_target_kind text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS dispatch_target_line_key text;

UPDATE dispatch_so_po_allocations
   SET dispatch_target_ref = sales_order_ref
 WHERE dispatch_target_ref IS NULL OR btrim(dispatch_target_ref) = '';

UPDATE dispatch_so_po_allocations
   SET dispatch_target_line_key = dispatch_target_ref || '::' || sales_order_ref || '::' || sales_line_id::text
 WHERE dispatch_target_line_key IS NULL OR btrim(dispatch_target_line_key) = '';

ALTER TABLE dispatch_so_po_allocations
  ALTER COLUMN dispatch_target_ref SET NOT NULL,
  ALTER COLUMN dispatch_target_line_key SET NOT NULL;

ALTER TABLE dispatch_so_po_allocations
  DROP CONSTRAINT IF EXISTS dispatch_so_po_allocations_dispatch_target_kind_check;

ALTER TABLE dispatch_so_po_allocations
  ADD CONSTRAINT dispatch_so_po_allocations_dispatch_target_kind_check CHECK (
    dispatch_target_kind IN ('normal', 'split', 'group')
  );

CREATE INDEX IF NOT EXISTS idx_dispatch_so_po_allocations_target
  ON dispatch_so_po_allocations (dispatch_target_ref, status, dispatch_target_line_key);

COMMENT ON COLUMN order_dependencies.dispatch_target_ref IS
  'Visible dispatch SO/group/split reference that owns this dependency.';

COMMENT ON COLUMN order_dependency_lines.dispatch_target_line_key IS
  'Stable visible-target line identity; prevents split sibling quantities from sharing one allocation cap.';

COMMENT ON COLUMN dispatch_so_po_allocations.dispatch_target_ref IS
  'Visible dispatch SO/group/split reference that owns this PO pickup allocation.';
