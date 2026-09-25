// @ts-check
import { query } from './db.js';
import { deliveryLoadConfirmation, postingOrderKeys } from './operator-load-state.js';

/** Only minimal order-scoped state is public; actor, photos and snapshots stay private.
 * @param {any} order
 */
export async function attachOperatorLoadState(order) {
  if (!order) return order;
  const commands = (await query(`SELECT c.id,c.status,c.last_error,c.created_at,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id',s.netsuite_transaction_id,'ref',s.netsuite_transaction_ref,'verified',s.status='posted',
        'observed',s.response->'observedTransaction')) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) AS transactions
    FROM operator_netsuite_posting_commands c
    LEFT JOIN operator_netsuite_posting_steps s ON s.command_id=c.id
    WHERE EXISTS (SELECT 1 FROM operator_netsuite_posting_order_claims claim
      WHERE claim.command_id=c.id AND claim.active=true AND claim.local_order_key=ANY($1::text[]))
    GROUP BY c.id ORDER BY c.created_at DESC,c.id`, [postingOrderKeys(order)])).rows;
  const command = commands[0];
  const transactions = commands.flatMap((/** @type {any} */ row) => row.transactions).flatMap((/** @type {any} */ row) => {
    const id = row.id || row.observed?.id, ref = row.ref || row.observed?.tranId;
    return id ? [{ id: Number(id), ref: String(ref || id), verified: row.verified === true }] : [];
  });
  return { ...order, confirmationSummary: deliveryLoadConfirmation(order), posting: command ? {
    jobId: command.id, status: command.status, loadBlocked: true, transactions,
    reason: command.status === 'attention' ? 'NetSuite verification needs review. This load is held until reconciliation finishes.'
      : 'This load is already being processed. Check its status before continuing.'
  } : null };
}
