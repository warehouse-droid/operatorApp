BEGIN;
-- Preserve the direct-PO exception; add only evidence-backed direct-TO IRs.
ALTER TABLE operator_netsuite_posting_commands DROP CONSTRAINT operator_posting_actor_or_direct_receipt;
ALTER TABLE operator_netsuite_posting_commands ADD CONSTRAINT operator_posting_actor_or_direct_receipt CHECK (
  actor_operator_id IS NOT NULL OR COALESCE((
    function_key='receiving' AND transaction_type='IR'
    AND input_snapshot->'localOperation'->>'kind'='direct_po_receipt'
    AND jsonb_typeof(input_snapshot->'directDeliveryEvidence')='object'
    AND input_snapshot->'directDeliveryEvidence'->>'completionEventId' ~ '^[1-9][0-9]*$'
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
COMMIT;
