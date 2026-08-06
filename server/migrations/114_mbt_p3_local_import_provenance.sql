-- Phase 3 local-resource imports preserve their CSV provenance in the generic
-- apply-result ledger. This is additive evidence only; it does not enable a
-- capability, import a file, or alter an operational record.

SET LOCAL lock_timeout = '3s';

ALTER TABLE mbt_import_apply_results
  DROP CONSTRAINT IF EXISTS mbt_import_apply_results_source;

ALTER TABLE mbt_import_apply_results
  ADD CONSTRAINT mbt_import_apply_results_source
  CHECK (source_kind IN (
    'netsuite_read', 'customer_master_event', 'csv_bootstrap', 'csv', 'manual'
  ));
