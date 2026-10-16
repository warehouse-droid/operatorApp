-- Local corrections are append-only; original load records and images remain intact.
CREATE TABLE IF NOT EXISTS operator_order_reopens (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  target_ref text NOT NULL,
  actor_operator_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  expected_state_hash text NOT NULL CHECK (expected_state_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  order_keys text[] NOT NULL CHECK (cardinality(order_keys) > 0),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'array'),
  retained_photo_refs jsonb NOT NULL CHECK (jsonb_typeof(retained_photo_refs) = 'array'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS operator_order_reopens_members ON operator_order_reopens USING gin(order_keys);

CREATE OR REPLACE FUNCTION operator_order_reopen_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Operator reopen corrections are immutable';
END $$;
DROP TRIGGER IF EXISTS operator_order_reopens_immutable ON operator_order_reopens;
CREATE TRIGGER operator_order_reopens_immutable BEFORE UPDATE OR DELETE ON operator_order_reopens
  FOR EACH ROW EXECUTE FUNCTION operator_order_reopen_immutable();
