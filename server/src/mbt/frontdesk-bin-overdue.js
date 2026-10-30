// @ts-check
import { query } from '../db.js';

/** @param {any} line @param {Date} [now] */
export function isBinOverdue(line, now = new Date()) {
  return !['closed', 'cancelled'].includes(line.status) && Boolean(line.binAvailableForService)
    && Boolean(line.plannedReturnAt) && new Date(line.plannedReturnAt).getTime() < now.getTime();
}

/** Read-only reminder projection: expiry never materializes a collection.
 * @param {Date} [now]
 */
export async function readOverdueBins(now = new Date()) {
  const result = await query(`SELECT l.service_line_id,l.contract_id,c.contract_number,c.customer_netsuite_id,
      c.customer_snapshot,l.planned_return_at,l.line_number,b.type_code,a.asset_code,r.rental_number::text,
      EXISTS(SELECT 1 FROM mbt_bin_orders o JOIN mbt_service_visits v ON v.service_visit_id=o.order_id
        WHERE o.service_line_id=l.service_line_id AND o.order_kind='collection' AND v.status<>'cancelled') AS collection_requested
    FROM mbt_contract_service_lines l JOIN mbt_contracts c USING(contract_id)
    JOIN mbt_bin_types b ON b.bin_type_id=l.bin_type_id
    JOIN mbt_bin_rental_numbers r USING(service_line_id)
    LEFT JOIN mbt_bin_assets a ON a.asset_id=r.current_asset_id
    LEFT JOIN mbt_bin_asset_state s ON s.asset_id=r.current_asset_id
    LEFT JOIN LATERAL (SELECT v.* FROM mbt_service_visits v WHERE v.service_line_id=l.service_line_id
      AND v.service_action IN ('delivery','exchange_bin') AND v.status<>'cancelled'
      ORDER BY v.visit_number DESC LIMIT 1) latest ON true
    LEFT JOIN mbt_bin_order_parts dp ON dp.order_id=latest.service_visit_id AND dp.part_role='delivery'
    LEFT JOIN mbt_service_visits delivery ON delivery.service_visit_id=dp.visit_id
    WHERE l.status NOT IN ('closed','cancelled') AND c.status NOT IN ('closed','cancelled')
      AND l.planned_return_at < $1::timestamptz
      AND (((latest.status='completed' OR delivery.status='completed')
          AND s.location_kind='customer_site' AND s.customer_site_profile_id=l.customer_site_profile_id)
        OR (r.current_asset_id IS NULL AND latest.status='completed'
          AND NOT EXISTS(SELECT 1 FROM mbt_service_visits v JOIN mbt_visit_steps step USING(service_visit_id)
            WHERE v.service_line_id=l.service_line_id AND v.visit_number>latest.visit_number
              AND step.action_code IN ('pickup_bin','pickup_loaded_bin') AND step.status='completed')))
    ORDER BY l.planned_return_at,r.rental_number LIMIT 200`, [now.toISOString()]);
  return { schemaVersion: 'mbt-frontdesk-overdue-v1', asOf: now.toISOString(), items: result.rows.map((/** @type {any} */ r) => ({
    serviceLineId: r.service_line_id, contractId: r.contract_id, contractNumber: r.contract_number,
    customerNetsuiteId: String(r.customer_netsuite_id),
    customerName: r.customer_snapshot.displayName || r.customer_snapshot.legalName || String(r.customer_netsuite_id),
    rentalReference: `BIN${r.rental_number.padStart(5, '0')}`, binTypeCode: r.type_code,
    assetCode: r.asset_code || null, plannedReturnAt: new Date(r.planned_return_at).toISOString(),
    collectionRequested: r.collection_requested
  })) };
}
