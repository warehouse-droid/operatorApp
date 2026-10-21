-- Add readable rental references and independently dispatched BIN parts.
-- Existing visits, snapshots, evidence and reference identities are untouched.
CREATE TABLE mbt_bin_rental_numbers (
  service_line_id uuid PRIMARY KEY REFERENCES mbt_contract_service_lines(service_line_id),
  rental_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE CHECK (rental_number > 0),
  current_asset_id uuid REFERENCES mbt_bin_assets(asset_id),
  recovery_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mbt_bin_orders (
  order_id uuid PRIMARY KEY REFERENCES mbt_service_visits(service_visit_id),
  service_line_id uuid NOT NULL REFERENCES mbt_bin_rental_numbers(service_line_id),
  order_kind text NOT NULL CHECK (order_kind IN ('delivery','exchange','collection')),
  exchange_number integer NOT NULL DEFAULT 0 CHECK (exchange_number >= 0),
  display_reference text NOT NULL UNIQUE,
  configuration jsonb,
  revision bigint NOT NULL DEFAULT 1,
  configured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((order_kind='exchange') = (exchange_number > 0))
);
CREATE INDEX mbt_bin_orders_rental ON mbt_bin_orders(service_line_id,order_kind,exchange_number);

CREATE TABLE mbt_bin_order_parts (
  visit_id uuid PRIMARY KEY REFERENCES mbt_service_visits(service_visit_id),
  order_id uuid NOT NULL REFERENCES mbt_bin_orders(order_id),
  part_role text NOT NULL CHECK (part_role IN ('delivery','collection')),
  asset_id uuid NOT NULL REFERENCES mbt_bin_assets(asset_id),
  display_reference text NOT NULL,
  linked_delivery_visit_id uuid REFERENCES mbt_service_visits(service_visit_id),
  UNIQUE (order_id,part_role)
);
CREATE INDEX mbt_bin_order_parts_asset ON mbt_bin_order_parts(asset_id);

CREATE TABLE mbt_bin_workflow_dependencies (
  dependent_visit_id uuid NOT NULL REFERENCES mbt_bin_order_parts(visit_id),
  dependent_action_code text NOT NULL,
  prerequisite_visit_id uuid NOT NULL REFERENCES mbt_bin_order_parts(visit_id),
  prerequisite_action_code text NOT NULL,
  same_day boolean NOT NULL DEFAULT false,
  PRIMARY KEY (dependent_visit_id,dependent_action_code,prerequisite_visit_id,prerequisite_action_code),
  FOREIGN KEY (dependent_visit_id,dependent_action_code)
    REFERENCES mbt_visit_steps(service_visit_id,action_code),
  FOREIGN KEY (prerequisite_visit_id,prerequisite_action_code)
    REFERENCES mbt_visit_steps(service_visit_id,action_code),
  CHECK (dependent_visit_id <> prerequisite_visit_id)
);
CREATE INDEX mbt_bin_workflow_dependencies_source ON mbt_bin_workflow_dependencies(prerequisite_visit_id);

-- Workflow holds preserve physical state. Connected successive parts may share
-- one asset; eligibility is serialized under the fleet and asset locks.
CREATE TABLE mbt_bin_workflow_claims (
  claim_id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES mbt_bin_assets(asset_id),
  visit_id uuid NOT NULL REFERENCES mbt_bin_order_parts(visit_id),
  truck_id bigint NOT NULL REFERENCES dispatch_trucks(id),
  reserved_from timestamptz NOT NULL,
  reserved_until timestamptz NOT NULL,
  created_by text NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved_until > reserved_from)
);
CREATE UNIQUE INDEX mbt_bin_workflow_claim_visit ON mbt_bin_workflow_claims(visit_id) WHERE released_at IS NULL;
CREATE INDEX mbt_bin_workflow_claim_asset ON mbt_bin_workflow_claims(asset_id) WHERE released_at IS NULL;

CREATE TABLE mbt_bin_workflow_events (
  event_id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES mbt_bin_orders(order_id),
  visit_id uuid REFERENCES mbt_service_visits(service_visit_id),
  source_event_id uuid UNIQUE,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION mbt_register_bin_order(p_visit_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v mbt_service_visits%ROWTYPE;
  r mbt_bin_rental_numbers%ROWTYPE;
  kind text;
  ordinal integer;
  ref text;
BEGIN
  SELECT * INTO v FROM mbt_service_visits WHERE service_visit_id=p_visit_id;
  IF v.service_line_id IS NULL OR v.service_action NOT IN ('delivery','exchange_bin','return_bin','collection') THEN RETURN; END IF;
  INSERT INTO mbt_bin_rental_numbers(service_line_id)
    SELECT v.service_line_id WHERE NOT EXISTS (
      SELECT 1 FROM mbt_bin_rental_numbers WHERE service_line_id=v.service_line_id
    ) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM mbt_bin_rental_numbers WHERE service_line_id=v.service_line_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM mbt_bin_orders WHERE order_id=p_visit_id) THEN RETURN; END IF;
  kind := CASE v.service_action WHEN 'delivery' THEN 'delivery' WHEN 'exchange_bin' THEN 'exchange' ELSE 'collection' END;
  -- A legacy duplicate root stays available under its original reference.
  IF kind <> 'exchange' AND EXISTS (
    SELECT 1 FROM mbt_bin_orders WHERE service_line_id=v.service_line_id AND order_kind=kind
  ) THEN RETURN; END IF;
  ordinal := 0;
  IF kind='exchange' THEN
    SELECT COALESCE(max(exchange_number),0)+1 INTO ordinal FROM mbt_bin_orders WHERE service_line_id=v.service_line_id;
  END IF;
  ref := 'BIN' || lpad(r.rental_number::text,GREATEST(5,length(r.rental_number::text)),'0')
    || CASE kind WHEN 'delivery' THEN 'D' WHEN 'collection' THEN 'C' ELSE 'X-' || ordinal::text END;
  INSERT INTO mbt_bin_orders(order_id,service_line_id,order_kind,exchange_number,display_reference)
    VALUES (p_visit_id,v.service_line_id,kind,ordinal,ref);
END $$;

CREATE FUNCTION mbt_register_bin_rental_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbt_bin_rental_numbers(service_line_id) VALUES (NEW.service_line_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mbt_register_bin_rental AFTER INSERT ON mbt_contract_service_lines
  FOR EACH ROW EXECUTE FUNCTION mbt_register_bin_rental_trigger();

CREATE FUNCTION mbt_register_bin_order_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mbt_register_bin_order(NEW.service_visit_id);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mbt_register_bin_order AFTER INSERT OR UPDATE OF service_line_id ON mbt_service_visits
  FOR EACH ROW EXECUTE FUNCTION mbt_register_bin_order_trigger();

INSERT INTO mbt_bin_rental_numbers(service_line_id)
SELECT service_line_id FROM mbt_contract_service_lines ORDER BY created_at,contract_id,line_number,service_line_id;
DO $$
DECLARE row record;
BEGIN
  FOR row IN SELECT service_visit_id FROM mbt_service_visits
    WHERE service_line_id IS NOT NULL ORDER BY contract_id,service_line_id,visit_number,service_visit_id
  LOOP PERFORM mbt_register_bin_order(row.service_visit_id); END LOOP;
END $$;

UPDATE mbt_bin_rental_numbers rental SET current_asset_id=(
  SELECT COALESCE(v.outgoing_asset_id,v.expected_asset_id)
  FROM mbt_service_visits v
  JOIN mbt_bin_asset_state s ON s.asset_id=COALESCE(v.outgoing_asset_id,v.expected_asset_id)
  WHERE v.service_line_id=rental.service_line_id AND v.status='completed'
    AND v.service_action IN ('delivery','exchange_bin')
    AND s.location_kind='customer_site' AND s.customer_site_profile_id=v.customer_site_profile_id
  ORDER BY v.actual_completed_at DESC NULLS LAST,v.visit_number DESC LIMIT 1
);

CREATE FUNCTION mbt_preserve_bin_reference_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='mbt_bin_rental_numbers' THEN
    IF NEW.service_line_id IS DISTINCT FROM OLD.service_line_id OR NEW.rental_number IS DISTINCT FROM OLD.rental_number THEN
      RAISE EXCEPTION 'BIN rental references are immutable';
    END IF;
  ELSE
    IF (NEW.order_id,NEW.service_line_id,NEW.order_kind,NEW.exchange_number,NEW.display_reference)
       IS DISTINCT FROM (OLD.order_id,OLD.service_line_id,OLD.order_kind,OLD.exchange_number,OLD.display_reference) THEN
      RAISE EXCEPTION 'BIN order references are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mbt_preserve_bin_rental_reference BEFORE UPDATE ON mbt_bin_rental_numbers
  FOR EACH ROW EXECUTE FUNCTION mbt_preserve_bin_reference_identity();
CREATE TRIGGER trg_mbt_preserve_bin_order_reference BEFORE UPDATE ON mbt_bin_orders
  FOR EACH ROW EXECUTE FUNCTION mbt_preserve_bin_reference_identity();

-- Front Desk extensions move the unissued final Collection's draft window too.
CREATE FUNCTION mbt_sync_bin_collection_window() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id uuid;
BEGIN
  SELECT order_id INTO root_id FROM mbt_bin_orders
    WHERE order_id=NEW.service_visit_id AND order_kind='collection' AND configuration IS NOT NULL;
  IF root_id IS NULL OR (NEW.scheduled_start_at,NEW.scheduled_end_at)
    IS NOT DISTINCT FROM (OLD.scheduled_start_at,OLD.scheduled_end_at) THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM mbt_bin_order_parts p JOIN mbt_service_visits v ON v.service_visit_id=p.visit_id
    WHERE p.order_id=root_id AND (v.dispatch_plan_id IS NOT NULL OR v.actual_started_at IS NOT NULL OR EXISTS(
      SELECT 1 FROM mbt_bin_planning_assignments a WHERE a.service_visit_id=p.visit_id AND a.released_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'Issued BIN collection instructions cannot be rescheduled by a parent amendment';
  END IF;
  UPDATE mbt_service_visits v SET scheduled_start_at=NEW.scheduled_start_at,scheduled_end_at=NEW.scheduled_end_at,
    revision=v.revision+1,updated_at=now(),updated_by=NEW.updated_by
    FROM mbt_bin_order_parts p WHERE p.visit_id=v.service_visit_id AND p.order_id=root_id;
  UPDATE mbt_bin_orders o SET configuration=jsonb_set(configuration,'{parts}',(
    SELECT jsonb_agg(part || jsonb_build_object('window',jsonb_build_object('startAt',NEW.scheduled_start_at,'endAt',NEW.scheduled_end_at)))
      FROM jsonb_array_elements(configuration->'parts') part)),revision=revision+1 WHERE o.order_id=root_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mbt_sync_bin_collection_window AFTER UPDATE OF scheduled_start_at,scheduled_end_at ON mbt_service_visits
  FOR EACH ROW EXECUTE FUNCTION mbt_sync_bin_collection_window();
