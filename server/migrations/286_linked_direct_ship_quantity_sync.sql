BEGIN;
-- A removed/replaced NetSuite line may retain recorded physical history while
-- contributing zero to the current direct-ship requirement.
ALTER TABLE order_dependency_lines DROP CONSTRAINT order_dependency_lines_allocated_check;
ALTER TABLE order_dependency_lines ADD CONSTRAINT order_dependency_lines_allocated_check
  CHECK (allocated_quantity >= 0 AND allocated_quantity < 'Infinity'::numeric);
COMMIT;
