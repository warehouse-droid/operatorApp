-- Original driver photos/times and completion events remain retained. This
-- append-only ledger records the precise identity correction for a physical CO.
CREATE TABLE dispatch_driver_co_identity_corrections (
  driver_job_record_id bigint PRIMARY KEY REFERENCES driver_job_records(id) ON DELETE RESTRICT,
  job_id text NOT NULL UNIQUE,
  co_ref text NOT NULL,
  original_order_refs jsonb NOT NULL CHECK (jsonb_typeof(original_order_refs) = 'array'),
  original_job_details jsonb NOT NULL,
  proof jsonb NOT NULL,
  reason text NOT NULL DEFAULT 'Grouped CO cargo references were used as customer-delivery execution references.',
  corrected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER trg_dispatch_driver_co_identity_corrections_immutable
  BEFORE UPDATE OR DELETE ON dispatch_driver_co_identity_corrections
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

CREATE FUNCTION dispatch_co_identity_ref_set(refs jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(refs) = 'array'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(refs) ref WHERE jsonb_typeof(ref) <> 'string' OR btrim(ref #>> '{}') = '')
    THEN ARRAY(SELECT DISTINCT lower(btrim(ref)) FROM jsonb_array_elements_text(refs) ref ORDER BY 1)
    ELSE NULL END
$$;

-- Resolve the exact logical stop, never a substring of its opaque ID. The
-- retained source membership distinguishes a physical CO from a CO wrapper.
CREATE FUNCTION dispatch_driver_co_identity_proof(plan bigint, load_ref text, stop_ref text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH matches AS (
    SELECT jsonb_build_object('coRef', co.co_ref, 'sourceOrderRef', co.source_order_ref,
      'sourceRefs', order_row->'childOrders', 'fromYard', co.from_location, 'toYard', co.to_location,
      'coCreatedAt', co.created_at, 'planId', plan, 'loadId', load_ref, 'stopId', stop_ref,
      'stopType', stop->>'type') AS proof
    FROM dispatch_plan_snapshots snapshot
    CROSS JOIN LATERAL jsonb_array_elements(snapshot.trucks) truck
    CROSS JOIN LATERAL jsonb_array_elements(truck->'loads') load
    CROSS JOIN LATERAL jsonb_array_elements(load->'stops') stop
    CROSS JOIN LATERAL jsonb_array_elements(snapshot.orders) order_row
    JOIN local_co_orders co ON co.co_ref = order_row->>'id'
    WHERE snapshot.plan_id = plan AND load->>'id' = load_ref AND stop->>'id' = stop_ref
      AND stop->>'orderId' = co.co_ref AND upper(order_row->>'type') = 'CO'
      AND stop->>'type' IN ('pick','drop')
      AND cardinality(dispatch_co_identity_ref_set(order_row->'childOrders')) > 0
      AND NOT EXISTS (SELECT 1 FROM unnest(dispatch_co_identity_ref_set(order_row->'childOrders')) ref WHERE ref LIKE 'co-%')
  ) SELECT CASE WHEN count(*) = 1 THEN (jsonb_agg(proof))->0 ELSE NULL END FROM matches
$$;

CREATE FUNCTION dispatch_normalize_driver_co_execution_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  proof jsonb;
  expected_location text;
BEGIN
  IF lower(btrim(COALESCE(NEW.stop_type,''))) NOT IN ('pickup','dropoff') THEN RETURN NEW; END IF;
  SELECT correction.proof INTO proof FROM dispatch_driver_co_identity_corrections correction
    WHERE correction.job_id = NEW.job_id AND correction.proof->>'planId' = NEW.plan_id::text
      AND correction.proof->>'loadId' = NEW.load_id AND correction.proof->>'stopId' = NEW.stop_id;
  IF proof IS NULL THEN
    proof := dispatch_driver_co_identity_proof(NEW.plan_id, NEW.load_id, NEW.stop_id);
  END IF;
  IF proof IS NULL THEN RETURN NEW; END IF;
  IF (NEW.stop_type = 'dropoff' AND proof->>'stopType' <> 'drop')
    OR (NEW.stop_type = 'pickup' AND proof->>'stopType' <> 'pick') THEN RETURN NEW; END IF;
  expected_location := CASE WHEN NEW.stop_type = 'dropoff' THEN proof->>'toYard' ELSE proof->>'fromYard' END;
  IF lower(btrim(COALESCE(NEW.job_details->>'location',''))) <> lower(btrim(expected_location))
    OR (NEW.completed_at IS NOT NULL AND NEW.completed_at < (proof->>'coCreatedAt')::timestamptz)
    OR dispatch_co_identity_ref_set(NEW.order_refs) IS DISTINCT FROM dispatch_co_identity_ref_set(proof->'sourceRefs')
    THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE'
    AND (OLD.plan_id,OLD.load_id,OLD.stop_id,OLD.stop_type) IS NOT DISTINCT FROM (NEW.plan_id,NEW.load_id,NEW.stop_id,NEW.stop_type)
    AND dispatch_co_identity_ref_set(OLD.order_refs) = dispatch_co_identity_ref_set(proof->'sourceRefs') THEN
    INSERT INTO dispatch_driver_co_identity_corrections
      (driver_job_record_id,job_id,co_ref,original_order_refs,original_job_details,proof)
    VALUES (OLD.id,OLD.job_id,proof->>'coRef',OLD.order_refs,OLD.job_details,proof)
    ON CONFLICT (driver_job_record_id) DO NOTHING;
  END IF;
  NEW.order_refs := jsonb_build_array(proof->>'coRef');
  NEW.job_details := COALESCE(NEW.job_details,'{}'::jsonb) || jsonb_build_object(
    'orderTypes',jsonb_build_array('CO'), 'coExecutionIdentity', proof);
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_00_driver_co_execution_identity
  BEFORE INSERT OR UPDATE ON driver_job_records
  FOR EACH ROW EXECUTE FUNCTION dispatch_normalize_driver_co_execution_identity();

-- A CO remains a yard-transfer leg even if a stale device retains an SO type.
-- Preserve the authoritative VRMA resolver and all other existing precedence.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('dispatch_completion_driver_order_kind(text,jsonb)'::regprocedure) INTO definition;
  IF position('SELECT CASE' IN definition) = 0 THEN RAISE EXCEPTION 'Completion-kind resolver changed'; END IF;
  definition := replace(definition, 'SELECT CASE',
    'SELECT CASE WHEN upper(btrim(raw_ref)) LIKE ''CO-%'' THEN NULL');
  EXECUTE definition;
END
$$;

CREATE VIEW dispatch_effective_order_completion_events AS
SELECT event.* FROM dispatch_order_completion_events event
WHERE NOT EXISTS (
  SELECT 1 FROM dispatch_driver_co_identity_corrections correction
  WHERE event.completion_evidence_type = 'driver_job'
    AND event.completion_evidence_id = correction.job_id
    AND lower(btrim(event.order_ref)) = ANY(dispatch_co_identity_ref_set(correction.original_order_refs))
);

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_viewdef('dispatch_order_completion_status'::regclass, true) INTO definition;
  IF position('dispatch_order_completion_events event' IN definition) = 0 THEN RAISE EXCEPTION 'Completion projection changed'; END IF;
  definition := replace(definition, 'dispatch_order_completion_events event', 'dispatch_effective_order_completion_events event');
  EXECUTE 'CREATE OR REPLACE VIEW dispatch_order_completion_status AS ' || definition;
END
$$;
