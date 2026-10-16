// @ts-check
import { query } from '../db.js';
import { MbtError } from './errors.js';

/** Require the latest physical placement, including a replacement, to finish.
 * @param {string} serviceLineId
 * @param {{lock?: boolean}} [options]
 */
export async function assertFrontdeskBinDelivered(serviceLineId, { lock = false } = {}) {
  const result = await query(
    `SELECT service_visit_id, status FROM mbt_service_visits
      WHERE service_line_id = $1::uuid
        AND service_action IN ('delivery', 'exchange_bin') AND status <> 'cancelled'
      ORDER BY visit_number DESC, service_visit_id DESC LIMIT 1
      ${lock ? 'FOR UPDATE' : ''}`,
    [serviceLineId]
  );
  if (result.rows[0]?.status !== 'completed') {
    throw new MbtError({ status: 409, code: 'MBT_FRONTDESK_BIN_NOT_DELIVERED',
      message: 'This bin can be exchanged or collected after Dispatch and the driver complete its delivery.' });
  }
}
