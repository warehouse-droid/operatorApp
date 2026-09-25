-- New confirmations own a single RA at batch level; legacy record IDs stay unique.
CREATE TABLE IF NOT EXISTS return_batch_authorizations (
  batch_id bigint PRIMARY KEY REFERENCES return_batches(id) ON DELETE CASCADE,
  external_id text NOT NULL UNIQUE,
  intent_snapshot jsonb NOT NULL,
  posting_policy jsonb NOT NULL,
  sync_status text NOT NULL CHECK (sync_status IN ('disabled','pending','failed','succeeded','manual_linked','cancelled')),
  sync_error text,
  sync_attempts integer NOT NULL DEFAULT 0,
  attempted_at timestamptz,
  netsuite_transaction_id bigint UNIQUE CHECK (netsuite_transaction_id > 0),
  netsuite_transaction_ref text,
  netsuite_transaction_status text,
  netsuite_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_return_batch_authorizations_recovery
  ON return_batch_authorizations(updated_at, batch_id)
  WHERE sync_status IN ('pending','failed');

CREATE OR REPLACE FUNCTION enforce_return_transaction_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.netsuite_transaction_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('return-transaction-owner:' || NEW.netsuite_transaction_id::text));
  IF TG_TABLE_NAME = 'return_batch_authorizations' THEN
    IF EXISTS(SELECT 1 FROM return_records WHERE netsuite_transaction_id=NEW.netsuite_transaction_id) THEN
      RAISE EXCEPTION 'NetSuite transaction already belongs to a legacy return' USING ERRCODE='23505';
    END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM return_batch_authorizations WHERE netsuite_transaction_id=NEW.netsuite_transaction_id) THEN
      RAISE EXCEPTION 'NetSuite transaction already belongs to a return batch' USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS return_batch_transaction_owner ON return_batch_authorizations;
CREATE TRIGGER return_batch_transaction_owner BEFORE INSERT OR UPDATE OF netsuite_transaction_id
  ON return_batch_authorizations FOR EACH ROW EXECUTE FUNCTION enforce_return_transaction_owner();
DROP TRIGGER IF EXISTS return_record_transaction_owner ON return_records;
CREATE TRIGGER return_record_transaction_owner BEFORE INSERT OR UPDATE OF netsuite_transaction_id
  ON return_records FOR EACH ROW EXECUTE FUNCTION enforce_return_transaction_owner();

CREATE OR REPLACE FUNCTION preserve_return_batch_authorization_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.batch_id <> OLD.batch_id OR NEW.external_id <> OLD.external_id
    OR NEW.intent_snapshot <> OLD.intent_snapshot OR NEW.posting_policy <> OLD.posting_policy THEN
    RAISE EXCEPTION 'An admitted Return Authorization intent is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS return_batch_authorization_intent_immutable ON return_batch_authorizations;
CREATE TRIGGER return_batch_authorization_intent_immutable BEFORE UPDATE ON return_batch_authorizations
  FOR EACH ROW EXECUTE FUNCTION preserve_return_batch_authorization_intent();
