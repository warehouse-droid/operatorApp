import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db.js';

// Migration 301 removed Driver-triggered queueing. Recovery scenarios retain
// explicitly reviewed historical candidates; they must never recreate that trigger.
export async function seedReviewedLegacyFulfillment(orderRef, completionEventId) {
  const event = (await query(`SELECT id FROM dispatch_order_completion_events
    WHERE order_ref=$1 AND ($2::bigint IS NULL OR id=$2) ORDER BY id DESC LIMIT 1`,
  [orderRef, completionEventId ?? null])).rows[0];
  assert.ok(event, 'Historical recovery requires durable completion evidence');
  assert.equal((await query('SELECT 1 FROM dispatch_sales_order_if_candidates WHERE completion_event_id=$1',
    [event.id])).rowCount, 0, 'Driver completion alone must not queue fulfillment');
  const id = randomUUID();
  await query(`INSERT INTO dispatch_sales_order_if_candidates
    (id,completion_event_id,dispatch_order_ref,external_id,resolution_action,resolution_reason,resolved_by,resolved_at)
    VALUES($1,$2,$3,$4,'historical_backfill','Reviewed retained pre-301 fixture','test',now())`,
  [id, event.id, orderRef, `MBBS-SOIF-${id}`]);
  return { id };
}
