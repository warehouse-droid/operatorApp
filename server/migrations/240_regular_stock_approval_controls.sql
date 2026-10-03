ALTER TABLE scm_smart_settings
  ADD COLUMN regular_stock_auto_approval_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN regular_stock_approval_minutes integer NOT NULL DEFAULT 15
    CHECK (regular_stock_approval_minutes BETWEEN 1 AND 10080);

CREATE UNIQUE INDEX regular_stock_handoffs_sales_order_unique ON regular_stock_handoffs(sales_order_id);
CREATE UNIQUE INDEX regular_stock_handoffs_sales_ref_unique ON regular_stock_handoffs(upper(btrim(sales_order_ref)));

-- Preserve the original deadline for unused approvals; claimed work can recover.
WITH approvals AS (
  SELECT r.id, COALESCE(max(l.decided_at),r.updated_at) AS approved_at
  FROM sales_stock_requests r JOIN sales_stock_request_lines l ON l.request_id=r.id
  WHERE r.workflow_version=2 AND NOT EXISTS(SELECT 1 FROM regular_stock_handoffs h WHERE h.request_id=r.id)
  GROUP BY r.id
  HAVING bool_or(l.status='approved') AND bool_and(l.status IN ('approved','rejected','cancelled'))
)
UPDATE sales_stock_requests r SET regular_details=r.regular_details||jsonb_build_object(
  'approvedAt',a.approved_at,'approvalValidityMinutes',15,'approvalExpiresAt',a.approved_at+interval '15 minutes')
FROM approvals a WHERE r.id=a.id AND NOT r.regular_details ? 'approvalExpiresAt';
