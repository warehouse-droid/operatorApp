ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS yard_location_ids integer[] NOT NULL DEFAULT ARRAY[]::integer[];

UPDATE operators
   SET yard_location_ids = ARRAY(
     SELECT DISTINCT location_id
       FROM unnest(COALESCE(yard_location_ids, ARRAY[]::integer[])) AS location_id
      WHERE location_id = ANY(ARRAY[1, 28, 15, 26]::integer[])
      ORDER BY location_id
   );

ALTER TABLE operators
  DROP CONSTRAINT IF EXISTS operators_role_check;

ALTER TABLE operators
  ADD CONSTRAINT operators_role_check
  CHECK (role IN ('operator', 'dispatcher', 'admin', 'scm', 'yard_manager', 'sales'));

ALTER TABLE operators
  DROP CONSTRAINT IF EXISTS operators_roles_allowed_check;

ALTER TABLE operators
  ADD CONSTRAINT operators_roles_allowed_check
  CHECK (
    cardinality(roles) > 0
    AND roles <@ ARRAY['operator', 'dispatcher', 'admin', 'scm', 'yard_manager', 'sales']::text[]
    AND role = ANY(roles)
  );

ALTER TABLE operators
  DROP CONSTRAINT IF EXISTS operators_yard_location_ids_allowed_check;

ALTER TABLE operators
  ADD CONSTRAINT operators_yard_location_ids_allowed_check
  CHECK (yard_location_ids <@ ARRAY[1, 28, 15, 26]::integer[]);
