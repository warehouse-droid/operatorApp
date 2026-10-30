-- Delivery evidence admits only its allocated PO lines, independently of the
-- whole-order transport status. Existing jobs and posted identities are retained.
ALTER TABLE dispatch_direct_po_ir_jobs
  ALTER COLUMN completion_event_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS delivery_job_record_id bigint REFERENCES driver_job_records(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS allocation_scoped boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS direct_po_allocation_receipt_delivery
  ON dispatch_direct_po_ir_jobs(local_po_id,delivery_job_record_id) WHERE allocation_scoped;
CREATE TABLE IF NOT EXISTS dispatch_direct_po_ir_allocation_claims (
  allocation_id bigint PRIMARY KEY REFERENCES dispatch_so_po_allocations(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES dispatch_direct_po_ir_jobs(id) ON DELETE RESTRICT,
  execution_event_id bigint NOT NULL UNIQUE REFERENCES dispatch_so_po_allocation_execution_events(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL CHECK(quantity>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS direct_po_ir_allocation_claims_job ON dispatch_direct_po_ir_allocation_claims(job_id);
DROP TRIGGER IF EXISTS trg_direct_po_ir_allocation_claims_immutable ON dispatch_direct_po_ir_allocation_claims;
CREATE TRIGGER trg_direct_po_ir_allocation_claims_immutable
  BEFORE UPDATE OR DELETE ON dispatch_direct_po_ir_allocation_claims
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

CREATE OR REPLACE FUNCTION dispatch_enqueue_allocated_po_ir_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase='delivered' AND NEW.allocated_sales_qty>0 THEN
    INSERT INTO dispatch_direct_po_ir_jobs(local_po_id,delivery_job_record_id,allocation_scoped)
    SELECT line.purchase_order_id,NEW.driver_job_record_id,true
      FROM purchase_order_lines line JOIN dispatch_so_po_allocations allocation
        ON allocation.id=NEW.allocation_id AND allocation.po_line_id=line.id
       AND allocation.po_order_id=line.purchase_order_id AND allocation.status='active'
     WHERE line.id=NEW.po_line_id
       AND NOT EXISTS (
         SELECT 1 FROM dispatch_direct_po_ir_jobs prior
         JOIN dispatch_order_completion_events event ON event.id=prior.completion_event_id
         WHERE prior.local_po_id=line.purchase_order_id AND event.completion_evidence_id=NEW.driver_job_id
       )
    ON CONFLICT(local_po_id,delivery_job_record_id) WHERE allocation_scoped DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_dispatch_enqueue_direct_po_ir_job ON dispatch_order_completion_events;
DROP TRIGGER IF EXISTS trg_dispatch_enqueue_allocated_po_ir_job ON dispatch_so_po_allocation_execution_events;
CREATE TRIGGER trg_dispatch_enqueue_allocated_po_ir_job
  AFTER INSERT ON dispatch_so_po_allocation_execution_events
  FOR EACH ROW EXECUTE FUNCTION dispatch_enqueue_allocated_po_ir_job();

ALTER TABLE operator_netsuite_posting_commands DROP CONSTRAINT operator_posting_actor_or_direct_receipt;
ALTER TABLE operator_netsuite_posting_commands ADD CONSTRAINT operator_posting_actor_or_direct_receipt CHECK (
  actor_operator_id IS NOT NULL OR COALESCE((
    function_key='receiving' AND transaction_type='IR'
    AND input_snapshot->'localOperation'->>'kind'='direct_po_receipt'
    AND jsonb_typeof(input_snapshot->'directDeliveryEvidence')='object'
    AND (input_snapshot->'directDeliveryEvidence'->>'completionEventId' ~ '^[1-9][0-9]*$'
      OR (input_snapshot->'directDeliveryEvidence'->>'receiptJobId'=request_id::text
        AND input_snapshot->'directDeliveryEvidence'->>'deliveryJobRecordId' ~ '^[1-9][0-9]*$'
        AND input_snapshot->'directDeliveryEvidence'->'executionEventIds'->>0 ~ '^[1-9][0-9]*$'))
  ) OR (
    function_key='receiving' AND transaction_type='IR'
    AND input_snapshot->'localOperation'->>'kind'='transfer_background_posting'
    AND input_snapshot->'localOperation'->>'orderType'='transfer_order'
    AND jsonb_typeof(input_snapshot->'directTransferEvidence')='object'
    AND input_snapshot->'directTransferEvidence'->>'sourceNetSuiteId' ~ '^[1-9][0-9]*$'
    AND input_snapshot->'directTransferEvidence'->>'sourceNetSuiteId'=input_snapshot->'localOperation'->>'orderId'
    AND input_snapshot->'directTransferEvidence'->'fulfillmentTransactionIds'->>0 ~ '^[1-9][0-9]*$'
    AND input_snapshot->'directTransferEvidence'->'driverOrderRefs'->>0 ~ '^SO'
    AND input_snapshot->'transferEvidence'->>'jobId'=request_id::text
    AND input_snapshot->'transferEvidence'->>'operatorRecordId' ~ '^[1-9][0-9]*$'
    AND input_snapshot->'transferEvidence'->>'completionEventId' ~ '^[1-9][0-9]*$'
  ),false)
);
