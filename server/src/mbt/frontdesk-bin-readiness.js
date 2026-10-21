// @ts-check
import { query } from '../db.js';
import { MbtError } from './errors.js';

/** Require the latest physical placement, including a replacement, to finish.
 * @param {string} serviceLineId
 * @param {{lock?: boolean}} [options]
 */
export async function assertFrontdeskBinDelivered(serviceLineId, { lock = false } = {}) {
  const result = await query(
    `SELECT v.service_visit_id,v.status,delivery.status AS delivery_status,r.current_asset_id,
        s.location_kind,s.customer_site_profile_id,v.customer_site_profile_id AS expected_site_id
      FROM mbt_service_visits v
      LEFT JOIN mbt_bin_order_parts p ON p.order_id=v.service_visit_id AND p.part_role='delivery'
      LEFT JOIN mbt_service_visits delivery ON delivery.service_visit_id=p.visit_id
      LEFT JOIN mbt_bin_rental_numbers r ON r.service_line_id=v.service_line_id
      LEFT JOIN mbt_bin_asset_state s ON s.asset_id=r.current_asset_id
      WHERE v.service_line_id = $1::uuid
        AND v.service_action IN ('delivery', 'exchange_bin') AND v.status <> 'cancelled'
      ORDER BY v.visit_number DESC, v.service_visit_id DESC LIMIT 1
      ${lock ? 'FOR UPDATE OF v' : ''}`,
    [serviceLineId]
  );
  const latest=result.rows[0];
  const replacementDelivered=latest?.delivery_status==='completed' && latest.current_asset_id
    && latest.location_kind==='customer_site' && latest.customer_site_profile_id===latest.expected_site_id;
  if (latest?.status !== 'completed' && !replacementDelivered) {
    throw new MbtError({ status: 409, code: 'MBT_FRONTDESK_BIN_NOT_DELIVERED',
      message: 'This bin can be exchanged or collected after Dispatch and the driver complete its delivery.' });
  }
}
