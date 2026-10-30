/** Applied reconciliation may be newer than the canonical order-sync header.
 * Proposals/reviews never hide work, and a later canonical sync wins.
 * @param {string} alias
 */
export function appliedSalesOrderBilledSql(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) { throw new TypeError('A safe sales order SQL alias is required.'); }
  return `EXISTS (
    SELECT 1 FROM scm_reconciliation_order_state applied_billing
    WHERE applied_billing.order_kind = 'SO'
      AND applied_billing.source_order_netsuite_id = ${alias}.netsuite_id
      AND applied_billing.reconciliation_status = 'current'
      AND applied_billing.application_status = 'Completed'
      AND applied_billing.reconciled_at >= ${alias}.synced_at
      AND applied_billing.proposed_state->>'dryRun' = 'false'
      AND applied_billing.proposed_state->>'billed' = 'true'
      AND applied_billing.proposed_state->>'locallyReopened' = 'false'
      AND applied_billing.proposed_state->>'blockedByActiveDraft' = 'false'
  )`;
}
