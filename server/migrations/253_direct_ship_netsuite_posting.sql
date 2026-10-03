BEGIN;
-- Only verified automatic direct receipts may omit an Operator identity.
ALTER TABLE operator_netsuite_posting_commands ALTER COLUMN actor_operator_id DROP NOT NULL;
ALTER TABLE operator_netsuite_posting_commands DROP CONSTRAINT IF EXISTS operator_posting_actor_or_direct_receipt;
ALTER TABLE operator_netsuite_posting_commands ADD CONSTRAINT operator_posting_actor_or_direct_receipt CHECK (
  actor_operator_id IS NOT NULL OR (
    function_key='receiving' AND transaction_type='IR'
    AND COALESCE(input_snapshot->'localOperation'->>'kind','')='direct_po_receipt'
    AND jsonb_typeof(input_snapshot->'directDeliveryEvidence')='object'
    AND COALESCE(input_snapshot->'directDeliveryEvidence'->>'completionEventId','') ~ '^[1-9][0-9]*$'
  )
);
CREATE TABLE IF NOT EXISTS dispatch_direct_po_ir_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  completion_event_id bigint NOT NULL UNIQUE REFERENCES dispatch_order_completion_events(id),
  local_po_id bigint NOT NULL REFERENCES purchase_orders(netsuite_id),
  command_id uuid UNIQUE REFERENCES operator_netsuite_posting_commands(id),
  status text NOT NULL DEFAULT 'discovered' CHECK(status IN('discovered','gate_disabled','admitted','reconciled','attention')),
  last_error text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION dispatch_enqueue_direct_po_ir_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_kind='PO' AND NEW.metadata->>'directPoLink'='true'
    AND NEW.metadata->>'directShipCoverageVerified'='true' AND NEW.completion_evidence_type='driver_job' THEN
    INSERT INTO dispatch_direct_po_ir_jobs(completion_event_id,local_po_id)
      VALUES(NEW.id,(NEW.metadata->>'poOrderId')::bigint) ON CONFLICT(completion_event_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_dispatch_enqueue_direct_po_ir_job ON dispatch_order_completion_events;
CREATE TRIGGER trg_dispatch_enqueue_direct_po_ir_job AFTER INSERT ON dispatch_order_completion_events
  FOR EACH ROW EXECUTE FUNCTION dispatch_enqueue_direct_po_ir_job();
CREATE INDEX IF NOT EXISTS dispatch_direct_po_ir_jobs_pending ON dispatch_direct_po_ir_jobs(created_at) WHERE command_id IS NULL;
COMMIT;
