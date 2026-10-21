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
                CASE event.completion_evidence_type
                    WHEN 'driver_job'::text THEN 10
                    WHEN 'direct_dependency'::text THEN 20
                    WHEN 'manual_dispatch'::text THEN 30
                    WHEN 'scm_vendor'::text THEN 35
                    WHEN 'reconciliation'::text THEN 40
                    WHEN 'vrma_completion'::text THEN 40
                    WHEN 'custom_order'::text THEN 40
                    WHEN 'netsuite_fulfillment'::text THEN 50
                    ELSE 100
                END), event.dispatch_completed_at DESC, event.id DESC) AS completion_rank
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
  WHERE completion_rank = 1
