ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS roles text[] NOT NULL DEFAULT ARRAY['operator']::text[];

UPDATE operators
   SET roles = ARRAY[role]::text[]
 WHERE roles IS NULL
    OR cardinality(roles) = 0
    OR NOT (role = ANY(roles));

ALTER TABLE operators
  DROP CONSTRAINT IF EXISTS operators_roles_allowed_check;

ALTER TABLE operators
  ADD CONSTRAINT operators_roles_allowed_check
  CHECK (
    cardinality(roles) > 0
    AND roles <@ ARRAY['operator', 'dispatcher', 'admin', 'scm', 'yard_manager']::text[]
    AND role = ANY(roles)
  );
