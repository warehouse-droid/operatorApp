-- Expand the small immutable reopen ledger once per statement. A hash anti
-- join replaces one JSON membership scan for every historical completion.
-- JSON ? matches string array elements, object keys, and scalar strings only.
CREATE OR REPLACE VIEW dispatch_effective_order_completion_events AS
WITH reopened_jobs AS MATERIALIZED (
  SELECT id, job_id FROM driver_job_corrections WHERE action = 'reopen'
  UNION ALL
  SELECT correction.id, visit.job_id
  FROM driver_job_corrections correction
  CROSS JOIN LATERAL (
    SELECT value #>> '{}' AS job_id
    FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(correction.result->'physicalVisitJobIds') = 'array'
      THEN correction.result->'physicalVisitJobIds' ELSE '[]'::jsonb END) value
    WHERE jsonb_typeof(value) = 'string'
    UNION ALL
    SELECT jsonb_object_keys(CASE
      WHEN jsonb_typeof(correction.result->'physicalVisitJobIds') = 'object'
      THEN correction.result->'physicalVisitJobIds' ELSE '{}'::jsonb END)
    UNION ALL
    SELECT correction.result->>'physicalVisitJobIds'
    WHERE jsonb_typeof(correction.result->'physicalVisitJobIds') = 'string'
  ) visit
  WHERE correction.action = 'reopen'
)
SELECT event.* FROM dispatch_order_completion_events event
WHERE NOT EXISTS (
  SELECT 1 FROM dispatch_driver_co_identity_corrections correction
  WHERE event.completion_evidence_type = 'driver_job'
    AND event.completion_evidence_id = correction.job_id
    AND lower(btrim(event.order_ref)) = ANY(dispatch_co_identity_ref_set(correction.original_order_refs))
)
  AND NOT EXISTS (
    SELECT 1 FROM dispatch_direct_ship_completion_corrections correction
    WHERE correction.completion_event_id = event.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM reopened_jobs correction
    WHERE event.completion_evidence_type = 'driver_job'
      AND correction.id > COALESCE(event.reopen_correction_id, 0)
      AND correction.job_id = event.completion_evidence_id
  );

-- Conservative search keys select candidate snapshots only. The existing
-- recursive identity/ETA calculation remains authoritative. Include every
-- nested identity, group member and split parent; unusual JSON or Unicode
-- forces a full check through the sentinel instead of risking a false negative.
CREATE OR REPLACE FUNCTION dispatch_snapshot_planning_refs(orders jsonb, trucks jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE COST 10000 AS $$
  WITH values_to_check AS MATERIALIZED (
    SELECT value FROM jsonb_path_query(orders, '$.**.id') value
    UNION ALL SELECT value FROM jsonb_path_query(orders, '$.**.originalOrderId') value
    UNION ALL SELECT value FROM jsonb_path_query(orders, '$.**.childOrders[*]') value
    UNION ALL SELECT value FROM jsonb_path_query(trucks, '$.**.orderId') value
    UNION ALL SELECT value FROM jsonb_path_query(trucks, '$.**.orderRefs[*]') value
  ), names AS MATERIALIZED (
    SELECT upper(btrim(value #>> '{}')) AS name FROM values_to_check
    WHERE jsonb_typeof(value) = 'string'
  ), refs AS (
    SELECT name FROM names
    UNION SELECT regexp_replace(name, '-S[0-9]+$', '') FROM names
    UNION SELECT '__MBBS_ANY_REFERENCE__' WHERE EXISTS (
      SELECT 1 FROM values_to_check
      WHERE jsonb_typeof(value) <> 'string' OR (value #>> '{}') !~ '^[ -~]*$'
    )
  ) SELECT COALESCE(array_agg(name), ARRAY[]::text[]) FROM refs WHERE name <> '';
$$;

CREATE INDEX idx_dispatch_snapshot_planning_refs
  ON dispatch_plan_snapshots USING gin (dispatch_snapshot_planning_refs(orders, trucks)) WITH (fastupdate = off);

-- This SO branch tests existence only: ranking all effective events cannot
-- change whether at least one SO completion exists. Avoid ranking history
-- again for each queue and navigation alert; preserve every other stage rule.
CREATE OR REPLACE VIEW special_stock_workflow_stages AS
SELECT special.request_id,
  CASE
    WHEN special.close_status = 'closed' OR request.status = 'cancelled' THEN 'closed'
    WHEN special.workflow_kind = 'backorder'
      AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE request_id=special.request_id AND supply_status='already_ordered')
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE request_id=special.request_id
        AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision NOT IN ('declined','closed')) THEN 'completed'
    WHEN special.workflow_kind = 'backorder' AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE request_id=special.request_id)
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE request_id=special.request_id AND sales_decision NOT IN ('declined','closed')) THEN 'closed'
    WHEN special.workflow_kind = 'backorder' AND special.sales_order_netsuite_id IS NOT NULL THEN 'completed'
    WHEN (special.workflow_kind <> 'backorder' OR (special.sales_order_netsuite_id IS NOT NULL AND special.purchase_order_netsuite_id IS NOT NULL)) AND (special.operationally_complete OR
      (special.fulfillment_method = 'mbt_delivery' AND EXISTS (
        SELECT 1 FROM dispatch_effective_order_completion_events completion
        WHERE completion.order_kind = 'SO'
          AND lower(btrim(completion.order_ref)) = lower(btrim(special.sales_order_ref)))) OR
      (special.fulfillment_method = 'yard_pickup' AND EXISTS (
        SELECT 1 FROM operator_load_records pickup
        WHERE pickup.order_id = special.sales_order_netsuite_id
          AND pickup.load_type = 'customer_pickup_load'
          AND pickup.response->>'pickupStatus' = 'loaded'))) THEN 'completed'
    WHEN special.information_request->>'status' = 'pending' THEN 'pending_update'
    WHEN special.workflow_kind = 'backorder' AND special.purchase_order_netsuite_id IS NOT NULL THEN 'dispatch_arrangement'
    WHEN special.workflow_kind = 'backorder' AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE request_id=special.request_id AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision='accepted')
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE request_id=special.request_id AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision NOT IN ('accepted','declined','closed')) THEN 'confirmed'
    WHEN special.line_edit_state->>'revision' = request.revision::text
      AND special.line_edit_state->>'stage' IN ('new_enquiry','await_customer_confirmation','wait_for_production','pending_update')
      AND special.sales_order_netsuite_id IS NULL AND special.purchase_order_netsuite_id IS NULL
      AND NOT special.sales_order_skipped AND NOT special.purchase_order_skipped
      THEN special.line_edit_state->>'stage'
    WHEN special.workflow_kind = 'special' AND special.purchase_order_netsuite_id IS NOT NULL AND NOT approval.approved THEN 'confirmed'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.request_id = special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed'))
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line
        WHERE line.request_id = special.request_id AND line.sales_decision = 'accepted'
          AND COALESCE(line.supply_status,'') NOT IN ('in_stock','low_inventory')) THEN 'wait_for_production'
    WHEN (special.purchase_order_netsuite_id IS NOT NULL OR special.purchase_order_skipped)
      AND (special.workflow_kind <> 'backorder' OR special.sales_order_netsuite_id IS NOT NULL)
      AND special.fulfillment_method <> 'vendor_pickup' THEN 'dispatch_arrangement'
    WHEN special.sales_order_netsuite_id IS NOT NULL OR special.sales_order_skipped THEN 'confirmed'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.request_id = special.request_id AND (line.supply_status IS NULL OR line.sales_decision = 'request_update')
        AND (special.workflow_kind <> 'backorder' OR line.supply_status IS DISTINCT FROM 'already_ordered')) THEN 'await_customer_confirmation'
    ELSE 'new_enquiry'
  END AS stage
FROM sales_special_stock_cases special
JOIN sales_stock_requests request ON request.id = special.request_id
JOIN special_stock_purchase_approval approval ON approval.request_id = special.request_id;

-- Share one evidence priority rule between whole-history and indexed per-order reads.
CREATE OR REPLACE FUNCTION dispatch_completion_evidence_priority(evidence_type text)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE evidence_type
                    WHEN 'driver_job'::text THEN 10
                    WHEN 'direct_dependency'::text THEN 20
                    WHEN 'manual_dispatch'::text THEN 30
                    WHEN 'scm_vendor'::text THEN 35
                    WHEN 'reconciliation'::text THEN 40
                    WHEN 'vrma_completion'::text THEN 40
                    WHEN 'custom_order'::text THEN 40
                    WHEN 'netsuite_fulfillment'::text THEN 50
                    ELSE 100
                END;
$$;

CREATE OR REPLACE VIEW dispatch_order_completion_status AS
WITH ranked AS (
         SELECT event.id,
            event.order_kind,
            event.order_ref,
            event.dispatch_completion_status,
            event.dispatch_completed_at,
            event.completion_evidence_type,
            event.completion_evidence_id,
            event.plan_id,
            event.plan_date,
            event.load_id,
            event.actor_type,
            event.actor_id,
            event.reason,
            event.metadata,
            event.created_at,
            row_number() OVER (PARTITION BY event.order_kind, (lower(btrim(event.order_ref))) ORDER BY (
                dispatch_completion_evidence_priority(event.completion_evidence_type)), event.dispatch_completed_at DESC, event.id DESC) AS completion_rank
           FROM dispatch_effective_order_completion_events event
          WHERE NOT (event.order_kind = 'PO'::text AND (EXISTS ( SELECT 1
                   FROM dispatch_order_completion_events corrected
                  WHERE corrected.order_kind = 'VRMA'::text AND lower(btrim(corrected.order_ref)) = lower(btrim(event.order_ref)) AND corrected.completion_evidence_type = event.completion_evidence_type AND corrected.completion_evidence_id = event.completion_evidence_id)))
        )
 SELECT id AS completion_event_id,
    order_kind,
    order_ref,
    dispatch_completion_status,
    dispatch_completed_at,
    completion_evidence_type,
    completion_evidence_id,
    plan_id,
    plan_date,
    load_id,
    actor_type,
    actor_id,
    reason,
    metadata,
    created_at
   FROM ranked
  WHERE completion_rank = 1;
