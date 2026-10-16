-- A native PO number is not the dispatch handoff. SCM must supply its reference
-- and queue it. Downstream transport states retain that handoff until completion.
CREATE OR REPLACE VIEW special_stock_purchase_dispatch_state AS
SELECT special.request_id,
  purchase.dispatch_ref AS dispatch_reference,
  COALESCE(NULLIF(btrim(schedule.status),''), NULLIF(btrim(purchase.initial_scm_status),''), 'Hold') AS dispatch_status,
  COALESCE(NULLIF(btrim(purchase.dispatch_ref),'') IS NOT NULL
    AND lower(COALESCE(NULLIF(btrim(schedule.status),''), NULLIF(btrim(purchase.initial_scm_status),''), 'Hold'))
      IN ('queued','planned','in transit','partially done','completed','complete'), false) AS ready
FROM sales_special_stock_cases special
LEFT JOIN purchase_orders purchase ON purchase.netsuite_id = special.purchase_order_netsuite_id
LEFT JOIN scm_transport_schedule schedule ON schedule.order_kind = 'PO'
  AND lower(btrim(schedule.order_ref)) = lower(COALESCE(NULLIF(btrim(purchase.dispatch_ref),''), purchase.tranid));

-- Customer confirmation is independent of transfer/production readiness.
-- Existing requests are projected immediately; no request or line data changes.
-- Completion evidence depends on the delivery method and the source of each order's progress.
CREATE OR REPLACE VIEW special_stock_completion_evidence AS
WITH evidence AS (
  SELECT special.request_id,special.workflow_kind,special.fulfillment_method,
    special.sales_order_netsuite_id,special.purchase_order_netsuite_id,
    sales_delivery.id AS sales_completion_event_id,
    sales_delivery.dispatch_completed_at AS sales_order_delivered_at,
    purchase_delivery.dispatch_completed_at AS purchase_order_delivered_at,
    pickup.completed_at AS yard_pickup_completed_at,
    sales.fulfilled_at AS sales_fulfilled_at,purchase.received_at AS purchase_received_at,
    (sales.netsuite_active IS DISTINCT FROM false AND
      lower(btrim(regexp_replace(COALESCE(sales.status_text,''),'^.*: *','')))
        IN ('fulfilled','fully fulfilled','billed','fully billed','pending billing')) AS sales_netsuite_fulfilled,
    (COALESCE(sales.fulfillment_status,'') !~* '(partial|closed|cancelled|canceled)' AND
      (sales.fulfilled_at IS NOT NULL OR pickup.completed_at IS NOT NULL
        OR lower(replace(COALESCE(sales.fulfillment_status,''),'_',' ')) IN ('fulfilled','fully fulfilled'))) AS sales_local_fulfilled,
    (purchase.netsuite_active IS DISTINCT FROM false AND
      lower(btrim(regexp_replace(COALESCE(purchase.status_text,''),'^.*: *','')))
        IN ('received','fully received','pending bill','billed','fully billed')) AS purchase_netsuite_received,
    (COALESCE(purchase.receipt_status,'') !~* 'partial' AND
      (purchase.receipt_status='received' OR purchase_delivery.dispatch_completed_at IS NOT NULL)) AS purchase_local_arrived
  FROM sales_special_stock_cases special
  LEFT JOIN sales_orders sales ON sales.netsuite_id=special.sales_order_netsuite_id
  LEFT JOIN purchase_orders purchase ON purchase.netsuite_id=special.purchase_order_netsuite_id
  LEFT JOIN LATERAL (
    SELECT event.id,event.dispatch_completed_at FROM dispatch_effective_order_completion_events event
    WHERE event.order_kind='SO' AND event.dispatch_completion_status='completed'
      AND lower(btrim(event.order_ref))=lower(btrim(special.sales_order_ref))
    ORDER BY dispatch_completion_evidence_priority(event.completion_evidence_type),event.dispatch_completed_at DESC,event.id DESC LIMIT 1
  ) sales_delivery ON true
  LEFT JOIN LATERAL (
    SELECT event.dispatch_completed_at FROM dispatch_effective_order_completion_events event
    WHERE event.order_kind='PO' AND event.dispatch_completion_status='completed'
      AND lower(btrim(event.order_ref)) IN (lower(btrim(special.purchase_order_ref)),lower(btrim(NULLIF(purchase.dispatch_ref,''))))
      AND NOT EXISTS (SELECT 1 FROM dispatch_order_completion_events returned
        WHERE returned.order_kind='VRMA' AND lower(btrim(returned.order_ref))=lower(btrim(event.order_ref))
          AND returned.completion_evidence_type=event.completion_evidence_type AND returned.completion_evidence_id=event.completion_evidence_id)
    ORDER BY dispatch_completion_evidence_priority(event.completion_evidence_type),event.dispatch_completed_at DESC,event.id DESC LIMIT 1
  ) purchase_delivery ON true
  LEFT JOIN LATERAL (
    SELECT max(record.created_at) AS completed_at FROM operator_load_records record
    WHERE record.order_id=special.sales_order_netsuite_id AND record.load_type='customer_pickup_load'
      AND record.response->>'pickupStatus'='loaded'
  ) pickup ON true
), classified AS (
  SELECT evidence.*,COALESCE(sales_order_netsuite_id IS NOT NULL AND purchase_order_netsuite_id IS NOT NULL
    AND CASE fulfillment_method
      WHEN 'mbt_delivery' THEN sales_order_delivered_at IS NOT NULL AND purchase_order_delivered_at IS NOT NULL
      WHEN 'yard_pickup' THEN purchase_local_arrived AND (sales_local_fulfilled OR sales_netsuite_fulfilled)
      WHEN 'vendor_pickup' THEN purchase_netsuite_received AND sales_netsuite_fulfilled
      ELSE false END,false) AS completed
  FROM evidence
)
SELECT request_id,sales_completion_event_id,sales_order_delivered_at,purchase_order_delivered_at,yard_pickup_completed_at,completed,
  CASE WHEN completed THEN CASE fulfillment_method
    WHEN 'mbt_delivery' THEN GREATEST(sales_order_delivered_at,purchase_order_delivered_at)
    WHEN 'yard_pickup' THEN CASE WHEN COALESCE(sales_fulfilled_at,yard_pickup_completed_at) IS NOT NULL
      AND COALESCE(purchase_order_delivered_at,purchase_received_at) IS NOT NULL
      THEN GREATEST(COALESCE(sales_fulfilled_at,yard_pickup_completed_at),COALESCE(purchase_order_delivered_at,purchase_received_at)) END
    END END AS completed_at,
  CASE WHEN completed THEN CASE fulfillment_method
    WHEN 'mbt_delivery' THEN 'dispatch_completion'
    WHEN 'yard_pickup' THEN CASE WHEN yard_pickup_completed_at IS NOT NULL THEN 'yard_pickup' ELSE 'linked_order_completion' END
    WHEN 'vendor_pickup' THEN 'netsuite_order_completion' END END AS completion_source
FROM classified;

CREATE OR REPLACE VIEW special_stock_workflow_stages AS
SELECT special.request_id,
  CASE
    WHEN special.close_status = 'closed' OR request.status = 'cancelled' THEN 'closed'
    WHEN special.workflow_kind = 'backorder'
      AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND supply_status='already_ordered')
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id
        AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision NOT IN ('declined','closed')) THEN 'completed'
    WHEN special.workflow_kind = 'backorder' AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id)
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND sales_decision NOT IN ('declined','closed')) THEN 'closed'
    WHEN completion.completed THEN 'completed'
    WHEN special.information_request->>'status' = 'pending' THEN 'pending_update'
    WHEN special.workflow_kind = 'backorder' AND special.purchase_order_netsuite_id IS NOT NULL
      THEN CASE WHEN dispatch_state.ready THEN 'dispatch_arrangement' ELSE 'confirmed' END
    WHEN special.workflow_kind = 'backorder' AND special.sales_order_netsuite_id IS NOT NULL THEN 'confirmed'
    WHEN special.workflow_kind = 'backorder' AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision='accepted')
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision NOT IN ('accepted','declined','closed')) THEN 'confirmed'
    WHEN special.workflow_kind = 'special' AND special.purchase_order_netsuite_id IS NOT NULL
      THEN CASE WHEN approval.approved AND dispatch_state.ready AND special.fulfillment_method <> 'vendor_pickup'
        THEN 'dispatch_arrangement' ELSE 'confirmed' END
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed'))
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line
        WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND line.sales_decision = 'accepted'
          AND COALESCE(line.supply_status,'') NOT IN ('in_stock','low_inventory')) THEN 'confirmed'
    WHEN special.purchase_order_skipped
      AND special.fulfillment_method <> 'vendor_pickup' THEN 'dispatch_arrangement'
    WHEN special.sales_order_netsuite_id IS NOT NULL OR special.sales_order_skipped THEN 'confirmed'
    WHEN special.workflow_kind = 'special'
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line WHERE line.removed_at IS NULL AND line.request_id=special.request_id AND line.sales_decision='accepted')
      AND NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line WHERE line.removed_at IS NULL AND line.request_id=special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed')) THEN 'confirmed'
    WHEN special.line_edit_state->>'revision' = request.revision::text
      AND special.line_edit_state->>'stage' IN ('new_enquiry','await_customer_confirmation','wait_for_production','pending_update')
      AND special.sales_order_netsuite_id IS NULL AND special.purchase_order_netsuite_id IS NULL
      AND NOT special.sales_order_skipped AND NOT special.purchase_order_skipped
      THEN special.line_edit_state->>'stage'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND (line.supply_status IS NULL OR line.sales_decision = 'request_update')
        AND (special.workflow_kind = 'backorder' OR line.sales_decision NOT IN ('declined','closed'))
        AND (special.workflow_kind <> 'backorder' OR line.supply_status IS DISTINCT FROM 'already_ordered')) THEN 'await_customer_confirmation'
    ELSE 'new_enquiry'
  END AS stage
FROM sales_special_stock_cases special
JOIN sales_stock_requests request ON request.id = special.request_id
JOIN special_stock_purchase_approval approval ON approval.request_id = special.request_id
JOIN special_stock_purchase_dispatch_state dispatch_state ON dispatch_state.request_id = special.request_id
LEFT JOIN special_stock_completion_evidence completion ON completion.request_id = special.request_id;
