ALTER TABLE dispatch_audit_log
  ALTER COLUMN operator_id TYPE text USING operator_id::text;
