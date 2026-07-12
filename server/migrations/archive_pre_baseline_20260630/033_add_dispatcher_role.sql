ALTER TABLE operators
  DROP CONSTRAINT IF EXISTS operators_role_check;

ALTER TABLE operators
  ADD CONSTRAINT operators_role_check
  CHECK (role IN ('operator', 'dispatcher', 'admin'));
