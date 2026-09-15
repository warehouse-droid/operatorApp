-- Operator grants are deliberately independent of Sales/Control grants.
ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS operator_yard_location_ids integer[] NOT NULL DEFAULT '{}';

ALTER TABLE operators
  DROP CONSTRAINT IF EXISTS operators_operator_yards_check;
ALTER TABLE operators
  ADD CONSTRAINT operators_operator_yards_check CHECK (
    operator_yard_location_ids <@ ARRAY[1, 28, 15, 26]::integer[]
    AND array_position(operator_yard_location_ids, NULL) IS NULL
  );
