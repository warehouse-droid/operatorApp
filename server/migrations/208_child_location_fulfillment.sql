-- A logical IF retains its existing external identity. Location parts are only
-- admitted after a definitive rejection of the original combined transform.
CREATE TABLE IF NOT EXISTS netsuite_item_fulfillment_plans (
  external_id text PRIMARY KEY,
  source_netsuite_id bigint NOT NULL CHECK (source_netsuite_id > 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS netsuite_item_fulfillment_parts (
  id bigserial PRIMARY KEY,
  plan_external_id text NOT NULL REFERENCES netsuite_item_fulfillment_plans(external_id) ON DELETE RESTRICT,
  location_id bigint NOT NULL CHECK (location_id > 0),
  external_id text NOT NULL UNIQUE,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posting','uncertain','posted','failed')),
  attempt_token uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  netsuite_transaction_id bigint,
  netsuite_transaction_ref text,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_external_id, location_id),
  CHECK (status <> 'posted' OR (netsuite_transaction_id IS NOT NULL AND netsuite_transaction_id > 0)),
  CHECK (status <> 'posting' OR attempt_token IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS netsuite_item_fulfillment_part_attempts (
  id uuid PRIMARY KEY,
  part_id bigint NOT NULL REFERENCES netsuite_item_fulfillment_parts(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('posting','posted','recovered','uncertain','failed')),
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (part_id, attempt_number)
);
CREATE OR REPLACE FUNCTION protect_item_fulfillment_plan_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'netsuite_item_fulfillment_plans' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'IF plan identity is immutable'; END IF;
  ELSIF (NEW.plan_external_id,NEW.location_id,NEW.external_id,NEW.payload_hash,NEW.payload)
     IS DISTINCT FROM (OLD.plan_external_id,OLD.location_id,OLD.external_id,OLD.payload_hash,OLD.payload) THEN
    RAISE EXCEPTION 'IF part identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_item_fulfillment_plan ON netsuite_item_fulfillment_plans;
CREATE TRIGGER immutable_item_fulfillment_plan BEFORE UPDATE ON netsuite_item_fulfillment_plans
  FOR EACH ROW EXECUTE FUNCTION protect_item_fulfillment_plan_identity();
DROP TRIGGER IF EXISTS immutable_item_fulfillment_part ON netsuite_item_fulfillment_parts;
CREATE TRIGGER immutable_item_fulfillment_part BEFORE UPDATE ON netsuite_item_fulfillment_parts
  FOR EACH ROW EXECUTE FUNCTION protect_item_fulfillment_plan_identity();
