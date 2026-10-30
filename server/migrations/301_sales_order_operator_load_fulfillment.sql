BEGIN;

-- Driver completion remains immutable delivery evidence; it no longer enqueues IFs.
DROP TRIGGER IF EXISTS trg_dispatch_enqueue_sales_order_if_candidate ON dispatch_order_completion_events;

ALTER TABLE dispatch_sales_order_if_candidates
  ALTER COLUMN completion_event_id DROP NOT NULL,
  ADD COLUMN operator_load_record_id bigint UNIQUE REFERENCES operator_load_records(id) ON DELETE RESTRICT,
  ADD COLUMN operator_load_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN activation_load_record_id bigint,
  ADD CONSTRAINT sales_order_if_one_origin CHECK
    ((completion_event_id IS NOT NULL)::int + (operator_load_record_id IS NOT NULL)::int = 1);

ALTER TABLE dispatch_sales_order_if_gate_watermarks
  ADD COLUMN activation_load_record_id bigint NOT NULL DEFAULT 0;
UPDATE dispatch_sales_order_if_gate_watermarks
   SET activation_load_record_id = COALESCE((SELECT MAX(id) FROM operator_load_records),0);

CREATE OR REPLACE FUNCTION dispatch_capture_sales_order_if_activation_watermark()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.flag_key LIKE 'dispatch_netsuite_sales_order_if_%'
     AND NEW.enabled = true
     AND (TG_OP = 'INSERT' OR COALESCE(OLD.enabled,false) = false) THEN
    INSERT INTO dispatch_sales_order_if_gate_watermarks
      (gate_key,gate_revision,activation_event_id,activation_load_record_id,activated_at,activated_by)
    VALUES (NEW.flag_key,NEW.revision,
      COALESCE((SELECT MAX(id) FROM dispatch_order_completion_events),0),
      COALESCE((SELECT MAX(id) FROM operator_load_records),0),clock_timestamp(),COALESCE(NEW.updated_by,''))
    ON CONFLICT(gate_key) DO UPDATE SET gate_revision=EXCLUDED.gate_revision,
      activation_event_id=EXCLUDED.activation_event_id,activation_load_record_id=EXCLUDED.activation_load_record_id,
      activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by,updated_at=now();
  END IF;
  RETURN NEW;
END $$;

-- Never abandon an attempted/ambiguous remote post. Those retain their identity
-- and existing recovery controls. Only untouched automatic Driver work is retired.
WITH retired AS (
  UPDATE dispatch_sales_order_if_candidates SET status='attention',
    last_error=concat_ws(' ','IF queueing now follows Operator loading. Review this retained legacy candidate before posting.',NULLIF(last_error,'')),
    result=result||'{"reason":"operator_load_trigger_replaced_driver_completion"}'::jsonb,updated_at=now()
  WHERE completion_event_id IS NOT NULL AND attempt_count=0
    AND status IN ('discovered','waiting_evidence','queued','gate_disabled','historical','attention')
    AND COALESCE(resolution_action,'automatic') IN ('automatic','recheck')
  RETURNING id
)
INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,details)
SELECT id,'operator_load_trigger_cutover','{"driverEvidenceRetained":true}'::jsonb FROM retired;
UPDATE dispatch_sales_order_if_line_claims claim SET active=false,released_at=now()
  FROM dispatch_sales_order_if_candidates candidate WHERE candidate.id=claim.candidate_id AND claim.active
    AND candidate.result->>'reason'='operator_load_trigger_replaced_driver_completion';

CREATE OR REPLACE FUNCTION operator_enqueue_sales_order_if_candidate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate_id uuid; retained jsonb;
BEGIN
  IF NEW.load_type <> 'sales_order_delivery_load' OR NEW.order_family <> 'sales_order'
     OR NEW.reload_cycle_id IS NOT NULL THEN RETURN NEW; END IF;
  -- The load path already serializes Operator mutations. Snapshot the increase,
  -- not the cumulative total, inside the same transaction as the physical load.
  SELECT COALESCE(jsonb_agg(line || jsonb_build_object(
    'sourceLineId',source_line.id,'orderLine',COALESCE(source_line.netsuite_order_line,source_line.line_id),
    'locationId',COALESCE(local_line.location_id,so.outbound_location_id),'quantity',
    GREATEST(0,COALESCE((line->>'loadedQty')::numeric,0)-COALESCE(previous.quantity,0)))),'[]'::jsonb)
    INTO retained
    FROM jsonb_array_elements(NEW.line_snapshot) line
    LEFT JOIN sales_orders so ON so.netsuite_id=NEW.order_id
    LEFT JOIN dispatch_scm_so_splits split ON split.split_so_id=so.netsuite_id AND split.status='active'
    LEFT JOIN sales_order_lines local_line ON local_line.sales_order_id=NEW.order_id
      AND local_line.line_id=(line->>'lineId')::bigint AND local_line.item_id=(line->>'itemId')::bigint
    LEFT JOIN sales_order_lines source_line ON source_line.sales_order_id=COALESCE(split.source_so_id,so.netsuite_id)
      AND source_line.line_id=local_line.line_id AND source_line.item_id=local_line.item_id
    LEFT JOIN LATERAL (
      SELECT MAX((prior_line->>'loadedQty')::numeric) AS quantity
        FROM operator_load_records prior CROSS JOIN LATERAL jsonb_array_elements(prior.line_snapshot) prior_line
       WHERE prior.order_id=NEW.order_id AND prior.order_family='sales_order'
         AND prior.load_type='sales_order_delivery_load' AND prior.reload_cycle_id IS NULL AND prior.id<NEW.id
         AND prior_line->>'lineId'=line->>'lineId'
         AND (prior_line->>'itemId' IS NULL OR prior_line->>'itemId'=line->>'itemId')
    ) previous ON true;
  candidate_id:=gen_random_uuid();
  INSERT INTO dispatch_sales_order_if_candidates(id,operator_load_record_id,operator_load_snapshot,
    dispatch_order_ref,external_id,source_sales_order_id,source_sales_order_ref)
  SELECT candidate_id,NEW.id,retained,NEW.order_ref,'MBBS-SOIF-'||candidate_id::text,
    COALESCE(split.source_so_id,so.netsuite_id),COALESCE(split.source_so_ref,so.tranid)
  FROM (SELECT 1) singleton LEFT JOIN sales_orders so ON so.netsuite_id=NEW.order_id
  LEFT JOIN dispatch_scm_so_splits split ON split.split_so_id=so.netsuite_id AND split.status='active'
  ON CONFLICT(operator_load_record_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_operator_enqueue_sales_order_if_candidate
  AFTER INSERT ON operator_load_records FOR EACH ROW EXECUTE FUNCTION operator_enqueue_sales_order_if_candidate();

COMMENT ON TABLE dispatch_sales_order_if_candidates IS
  'Operator-load SO IF outbox with retained legacy completion records for audited recovery.';
COMMIT;
