// @ts-check
import { Router } from 'express';
import { query } from './db.js';
import { getPublicOperatorNetSuitePostingCommand } from './operator-netsuite-posting-controller.js';
import { assertOperatorYard } from './operator-yard-access.js';

/** @param {{operatorId: string, order: Record<string, any>, locationId: number}} input */
export async function readOperatorReceiptRecovery({ operatorId, order, locationId }) {
  const identity = { netsuite_id: String(order.netsuite_id), order_type: order.order_type,
    tranid: order.tranid, destination_location_id: Number(order.destination_location_id) };
  if (!['purchase_order', 'transfer_order'].includes(identity.order_type)) return { order: identity, job: null };
  const found = await query(`SELECT command.id
    FROM operator_netsuite_posting_commands command
    JOIN operator_netsuite_posting_order_claims claim ON claim.command_id=command.id
    WHERE command.function_key='receiving' AND command.transaction_type='IR'
      AND claim.function_key='receiving' AND claim.local_order_key=$1
      AND command.actor_operator_id=$2 AND command.canonical_location_id=$3
    ORDER BY command.created_at DESC, command.id DESC LIMIT 1`,
  [`receiving:${identity.order_type}:${identity.netsuite_id}`, operatorId, locationId]);
  const id = found.rows[0]?.id;
  return { order: identity, job: id ? await getPublicOperatorNetSuitePostingCommand(id) : null };
}

export function createOperatorReceiptRecoveryRouter() {
  const router = Router();
  router.get('/orders/:id/posting-status', async (req, res, next) => {
    try {
      const request = /** @type {any} */ (req);
      const order = request.operatorYardOrder;
      const locationId = assertOperatorYard(request.operator, order.destination_location_id);
      if (request.query.locationId !== undefined && Number(request.query.locationId) !== locationId) {
        throw Object.assign(new Error('The receipt belongs to another receiving yard.'), { status: 403 });
      }
      res.setHeader('cache-control', 'no-store');
      res.json(await readOperatorReceiptRecovery({ operatorId: request.operator.id, order, locationId }));
    } catch (error) { next(error); }
  });
  return router;
}
