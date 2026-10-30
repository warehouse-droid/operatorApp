-- Preserve original accepted charges; explicit bin revisions record signed differences.
ALTER TABLE mbt_frontdesk_charge_requests DROP CONSTRAINT mbt_frontdesk_charge_requests_kind;
ALTER TABLE mbt_frontdesk_charge_requests ADD CONSTRAINT mbt_frontdesk_charge_requests_kind
 CHECK (request_kind IN ('initial_bin','add_bin','exchange_bin','change_bin','aggregate_order'));
ALTER TABLE mbt_frontdesk_charge_requests DROP CONSTRAINT mbt_frontdesk_charge_requests_subject_shape;
ALTER TABLE mbt_frontdesk_charge_requests ADD CONSTRAINT mbt_frontdesk_charge_requests_subject_shape CHECK (
 (request_kind='aggregate_order' AND contract_id IS NULL AND service_line_id IS NULL)
 OR (request_kind='initial_bin' AND service_line_id IS NULL)
 OR (request_kind='add_bin' AND contract_id IS NOT NULL AND service_line_id IS NULL)
 OR (request_kind IN ('exchange_bin','change_bin') AND contract_id IS NOT NULL AND service_line_id IS NOT NULL));
ALTER TABLE mbt_frontdesk_charge_requests DROP CONSTRAINT mbt_frontdesk_charge_requests_amounts_nonnegative;
ALTER TABLE mbt_frontdesk_charge_requests ADD CONSTRAINT mbt_frontdesk_charge_requests_amounts_nonnegative CHECK (
 current_contract_total_minor>=0 AND resulting_contract_total_minor>=0 AND required_deposit_minor>=0
 AND (request_kind='change_bin' OR (pre_tax_revenue_minor>=0 AND included_hst_minor>=0 AND added_hst_minor>=0
   AND request_total_minor>=0 AND due_now_minor>=0)));
ALTER TABLE mbt_frontdesk_charge_requests DROP CONSTRAINT mbt_frontdesk_charge_requests_due_now_conservation;
ALTER TABLE mbt_frontdesk_charge_requests ADD CONSTRAINT mbt_frontdesk_charge_requests_due_now_conservation CHECK (
 (request_kind<>'change_bin' AND due_now_minor>=required_deposit_minor AND due_now_minor-required_deposit_minor<=request_total_minor)
 OR (request_kind='change_bin' AND pricing_snapshot->'calculation'->>'depositCreditMinor' IS NOT NULL
   AND (pricing_snapshot->'calculation'->>'depositCreditMinor')::bigint>=0
   AND due_now_minor=request_total_minor+required_deposit_minor-(pricing_snapshot->'calculation'->>'depositCreditMinor')::bigint));
