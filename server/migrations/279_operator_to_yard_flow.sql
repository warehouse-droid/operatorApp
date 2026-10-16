BEGIN;
-- Preserve every immutable job/command. New waits describe missing physical evidence.
ALTER TABLE transfer_order_posting_jobs DROP CONSTRAINT IF EXISTS transfer_order_posting_jobs_status_check;
ALTER TABLE transfer_order_posting_jobs ADD CONSTRAINT transfer_order_posting_jobs_status_check
  CHECK (status IN ('waiting_load','waiting_receipt','waiting_driver','waiting_fulfillment',
    'waiting_posting','gate_disabled','admitted','completed','attention'));
COMMIT;
