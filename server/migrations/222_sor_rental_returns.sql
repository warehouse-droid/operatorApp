CREATE TABLE sor_item_policies (
  item_id bigint PRIMARY KEY,
  item_name text NOT NULL DEFAULT '',
  full_name text NOT NULL DEFAULT '',
  item_type text NOT NULL DEFAULT '',
  auto_return_override boolean,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  metadata_synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);
CREATE TABLE sor_signature_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  terms text NOT NULL CHECK (char_length(btrim(terms)) BETWEEN 1 AND 10000),
  revision bigint NOT NULL DEFAULT 1,
  returns_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);
INSERT INTO sor_signature_settings(singleton,terms)
VALUES(true,'I acknowledge receipt of the items listed for this delivery.');
CREATE TABLE sor_signature_terms_history (
  revision bigint PRIMARY KEY,
  terms text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);
INSERT INTO sor_signature_terms_history SELECT revision,terms,updated_at,updated_by FROM sor_signature_settings;
CREATE TABLE sor_return_reconcile_queue (
  source_ref text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 1,
  requested_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT ''
);
CREATE TABLE sor_configuration_audit (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  subject text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dispatch_custom_orders
  ADD COLUMN sor_source_fingerprint text NOT NULL DEFAULT '',
  ADD COLUMN sor_review_reason text NOT NULL DEFAULT '',
  ADD COLUMN sor_customer text NOT NULL DEFAULT '';
ALTER TABLE dispatch_custom_orders DROP CONSTRAINT dispatch_custom_orders_order_kind_valid;
ALTER TABLE dispatch_custom_orders ADD CONSTRAINT dispatch_custom_orders_order_kind_valid
  CHECK (order_kind IN ('custom','sales_order_reattempt','sor_rental_return'));
ALTER TABLE dispatch_custom_orders DROP CONSTRAINT dispatch_custom_orders_weight_valid;
ALTER TABLE dispatch_custom_orders ADD CONSTRAINT dispatch_custom_orders_weight_valid
  CHECK (weight_lbs >= 0 AND weight_lbs <= 1000000
    AND (order_kind IN ('sales_order_reattempt','sor_rental_return') OR weight_lbs > 0));
ALTER TABLE dispatch_custom_orders DROP CONSTRAINT dispatch_custom_orders_pickup_not_blank;
ALTER TABLE dispatch_custom_orders ADD CONSTRAINT dispatch_custom_orders_pickup_not_blank
  CHECK (btrim(pickup_location) <> '' OR order_kind='sor_rental_return');
ALTER TABLE dispatch_custom_orders ADD CONSTRAINT dispatch_sor_return_link_valid CHECK (
  order_kind <> 'sor_rental_return' OR (system_managed AND parent_sales_order_id IS NOT NULL
    AND parent_order_ref ~ '^SOR[0-9]+(-S[0-9]+)?$'
    AND ref_number = parent_order_ref || '-Return'
    AND billing_disposition='linked_parent_no_charge'
    AND jsonb_typeof(line_snapshot)='array')
);
CREATE UNIQUE INDEX dispatch_sor_return_source_unique ON dispatch_custom_orders(lower(parent_order_ref))
  WHERE order_kind='sor_rental_return';

CREATE FUNCTION enqueue_sor_return_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; candidate jsonb;
BEGIN
  candidate := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='sales_order_lines' THEN
    SELECT tranid INTO ref FROM sales_orders WHERE netsuite_id=(candidate->>'sales_order_id')::bigint;
  ELSIF TG_TABLE_NAME='dispatch_custom_orders' THEN
    IF candidate->>'order_kind' <> 'sor_rental_return' THEN RETURN NULL; END IF;
    ref := candidate->>'parent_order_ref';
  ELSIF TG_TABLE_NAME='dispatch_global_order_splits' THEN ref:=candidate->>'parent_order_ref';
  ELSIF TG_TABLE_NAME='dispatch_plan_order_assignments' THEN ref:=candidate->>'order_ref';
  ELSE ref:=candidate->>'tranid'; END IF;
  ref:=regexp_replace(regexp_replace(upper(ref),'-RETURN$',''),'-S[0-9]+$','');
  IF ref ~ '^SOR[0-9]+$' THEN
    INSERT INTO sor_return_reconcile_queue(source_ref) VALUES(ref)
      ON CONFLICT(source_ref) DO UPDATE SET version=sor_return_reconcile_queue.version+1,
        requested_at=now(),attempts=0,last_error='';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sor_header_changed AFTER INSERT OR UPDATE OR DELETE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION enqueue_sor_return_change();
CREATE TRIGGER sor_lines_changed AFTER INSERT OR UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION enqueue_sor_return_change();
CREATE TRIGGER sor_splits_changed AFTER INSERT OR UPDATE OR DELETE ON dispatch_global_order_splits
  FOR EACH ROW EXECUTE FUNCTION enqueue_sor_return_change();
CREATE TRIGGER sor_assignments_changed AFTER INSERT OR UPDATE OR DELETE ON dispatch_plan_order_assignments
  FOR EACH ROW EXECUTE FUNCTION enqueue_sor_return_change();
INSERT INTO sor_return_reconcile_queue(source_ref)
SELECT DISTINCT regexp_replace(upper(tranid),'-S[0-9]+$','') FROM sales_orders WHERE tranid ~* '^SOR[0-9]+(-S[0-9]+)?$';
