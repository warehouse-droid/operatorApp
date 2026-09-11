BEGIN;

ALTER TABLE dispatch_order_completion_events
  DROP CONSTRAINT dispatch_order_completion_evidence_type_valid;
ALTER TABLE dispatch_order_completion_events
  ADD CONSTRAINT dispatch_order_completion_evidence_type_valid
  CHECK (completion_evidence_type IN (
    'driver_job', 'direct_dependency', 'manual_dispatch', 'reconciliation',
    'netsuite_fulfillment', 'vrma_completion', 'custom_order', 'scm_vendor'
  ));
ALTER TABLE dispatch_order_completion_events
  DROP CONSTRAINT IF EXISTS dispatch_order_completion_vendor_audit;
ALTER TABLE dispatch_order_completion_events
  ADD CONSTRAINT dispatch_order_completion_vendor_audit
  CHECK (completion_evidence_type <> 'scm_vendor' OR (
    order_kind IN ('PO', 'TO', 'VRMA') AND actor_type = 'operator'
    AND NULLIF(btrim(actor_id), '') IS NOT NULL
    AND NULLIF(btrim(reason), '') IS NOT NULL
    AND plan_id IS NULL AND plan_date IS NULL AND load_id IS NULL
    AND metadata @> '{"netSuiteUpdated":false}'::jsonb
  ));

-- Keep the existing corrected-reference exclusions and future view columns.
-- Explicit Vendor completion outranks inferred receipt reconciliation.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_viewdef('dispatch_order_completion_status'::regclass, true) INTO definition;
  IF position('scm_vendor' IN definition) = 0 THEN
    IF position('WHEN ''manual_dispatch''::text THEN 30' IN definition) = 0 THEN
      RAISE EXCEPTION 'Dispatch completion ranking changed; review Vendor precedence before migrating';
    END IF;
    definition := replace(definition, 'WHEN ''manual_dispatch''::text THEN 30',
      'WHEN ''manual_dispatch''::text THEN 30 WHEN ''scm_vendor''::text THEN 35');
    EXECUTE 'CREATE OR REPLACE VIEW dispatch_order_completion_status AS ' || definition;
  END IF;
END
$$;

COMMIT;
