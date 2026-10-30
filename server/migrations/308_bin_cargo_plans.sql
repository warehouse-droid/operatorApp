CREATE TABLE mbt_bin_cargo_plans (
  order_id uuid NOT NULL REFERENCES mbt_bin_orders(order_id) ON DELETE RESTRICT,
  part_role text NOT NULL CHECK (part_role IN ('delivery','collection')),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  custom_order_id bigint REFERENCES dispatch_custom_orders(id) ON DELETE RESTRICT,
  completed_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id,part_role)
);
CREATE UNIQUE INDEX mbt_bin_cargo_custom_claim ON mbt_bin_cargo_plans(custom_order_id)
  WHERE custom_order_id IS NOT NULL AND completed_at IS NULL;

CREATE FUNCTION mbt_release_cancelled_bin_cargo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mbt_bin_cargo_plans SET completed_at=now(),updated_at=now()
    WHERE order_id=NEW.service_visit_id AND completed_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mbt_release_cancelled_bin_cargo AFTER UPDATE OF status ON mbt_service_visits
  FOR EACH ROW WHEN (NEW.status='cancelled' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION mbt_release_cancelled_bin_cargo();
