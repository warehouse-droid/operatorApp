CREATE SEQUENCE IF NOT EXISTS stock_exchange_reference_seq START WITH 1;
ALTER TABLE return_drafts DROP CONSTRAINT IF EXISTS return_drafts_draft_type_check;
ALTER TABLE return_drafts ADD CONSTRAINT return_drafts_draft_type_check
  CHECK (draft_type IN ('stock','pallet','combined','exchange'));
ALTER TABLE return_records DROP CONSTRAINT IF EXISTS return_records_record_type_check;
ALTER TABLE return_records ADD CONSTRAINT return_records_record_type_check
  CHECK (record_type IN ('stock','pallet','exchange'));
ALTER TABLE return_records DROP CONSTRAINT IF EXISTS return_records_type_fields_check;
ALTER TABLE return_records ADD CONSTRAINT return_records_type_fields_check CHECK (
  (record_type='stock' AND stock_return_type IS NOT NULL AND source_sales_order_id IS NOT NULL)
  OR (record_type='pallet' AND stock_return_type IS NULL AND pallet_quantity>0)
  OR (record_type='exchange' AND stock_return_type='quality' AND source_sales_order_id IS NOT NULL
    AND receiving_location_id IN (1,28,26) AND pallet_quantity IS NULL));
ALTER TABLE return_records DROP CONSTRAINT IF EXISTS return_records_netsuite_stage_check;
ALTER TABLE return_records ADD CONSTRAINT return_records_netsuite_stage_check
  CHECK (netsuite_stage IN ('local','return_authorization','credit_memo','inventory_transfer'));
-- Exchanges share a monthly transfer; existing return transaction uniqueness stays intact.
DROP INDEX IF EXISTS idx_return_records_netsuite_transaction_unique;
CREATE UNIQUE INDEX idx_return_records_netsuite_transaction_unique
  ON return_records(netsuite_transaction_id) WHERE netsuite_transaction_id IS NOT NULL AND record_type<>'exchange';

CREATE TABLE IF NOT EXISTS return_exchange_months (
  id bigserial PRIMARY KEY,
  location_id bigint NOT NULL REFERENCES return_yard_settings(location_id) CHECK (location_id IN (1,28,26)),
  month text NOT NULL CHECK (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  external_id text NOT NULL UNIQUE,
  transfer_id bigint UNIQUE,
  transfer_ref text,
  UNIQUE(location_id,month)
);
CREATE TABLE IF NOT EXISTS return_exchange_postings (
  record_id bigint PRIMARY KEY REFERENCES return_records(id) ON DELETE CASCADE,
  month_id bigint NOT NULL REFERENCES return_exchange_months(id),
  intent jsonb NOT NULL,
  attempted_at timestamptz,
  safe_to_retry boolean NOT NULL DEFAULT true,
  proof jsonb,
  confirmed_lines jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS return_exchange_postings_month ON return_exchange_postings(month_id);
CREATE OR REPLACE FUNCTION preserve_return_exchange_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.record_id<>OLD.record_id OR NEW.month_id<>OLD.month_id OR NEW.intent<>OLD.intent THEN
    RAISE EXCEPTION 'An admitted stock exchange intent is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS return_exchange_intent_immutable ON return_exchange_postings;
CREATE TRIGGER return_exchange_intent_immutable BEFORE UPDATE ON return_exchange_postings
  FOR EACH ROW EXECUTE FUNCTION preserve_return_exchange_intent();

INSERT INTO mbt_feature_flags(flag_key,enabled,description)
SELECT 'operator_netsuite_stock_exchange_it_' || yard,false,
  'Post Stock exchange to the monthly Inventory Transfer at ' || yard || '.'
FROM unnest(ARRAY['3445','2967','150']) yard ON CONFLICT(flag_key) DO NOTHING;
