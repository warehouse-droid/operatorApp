// @ts-check
import { query, withTransaction } from "./db.js";

/** @param {number} status @param {string} code @param {string} message */
function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** @param {unknown} value */
export function normalizeScmVendorCompletion(value) {
  const input = value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : {};
  const kind = String(input.orderKind || "").trim().toUpperCase();
  const ref = String(input.orderRef || "").trim();
  const actor = input.actor || {};
  const actorId = String(actor.id || "").trim();
  const roles = [...(Array.isArray(actor.roles) ? actor.roles : []), actor.role]
    .map(role => String(role || "").trim().toLowerCase().replaceAll(/[- ]/gu, "_"));
  if (!actorId || !roles.some(role => ["admin", "scm", "scm_staff"].includes(role))) {
    throw failure(403, "SCM_VENDOR_FORBIDDEN", "SCM edit access is required.");
  }
  if (!["PO", "TO", "VRMA"].includes(kind) || !ref || ref.length > 200) {
    throw failure(400, "SCM_VENDOR_ORDER_INVALID", "A valid PO, TO, or VRMA reference is required.");
  }
  const revision = String(input.expectedUpdatedAt || "").trim();
  if (!revision || !Number.isFinite(Date.parse(revision))) {
    throw failure(409, "SCM_VENDOR_STALE", "Refresh this order before marking it Completed.");
  }
  return { kind, ref, actorId, revision };
}

/** @param {string} kind @param {string} ref */
async function assertSourceExists(kind, ref) {
  const source = /** @type {Record<string,string>} */ ({
    PO: "SELECT netsuite_id FROM purchase_orders WHERE lower(tranid)=lower($1) OR lower(dispatch_ref)=lower($1)",
    TO: "SELECT netsuite_id FROM transfer_orders WHERE lower(tranid)=lower($1)",
    VRMA: "SELECT id FROM scm_vrma_orders WHERE lower(vrma_ref)=lower($1)"
  });
  const result = await query(`${source[kind]} LIMIT 1 FOR SHARE`, [ref]);
  if (!result.rowCount) throw failure(404, "SCM_VENDOR_ORDER_NOT_FOUND", "The source order was not found.");
}

/** Record only local operational evidence. No NetSuite adapter or posting queue is used.
 * @param {unknown} value
 */
export async function completeScmVendorOrder(value) {
  const { kind, ref, actorId, revision } = normalizeScmVendorCompletion(value);
  return withTransaction(async () => {
    const selected = await query(
      `SELECT *, updated_at::text AS revision
         FROM scm_transport_schedule
        WHERE order_kind=$1 AND lower(order_ref)=lower($2)
        LIMIT 2 FOR UPDATE`, [kind, ref]
    );
    if (!selected.rowCount) throw failure(404, "SCM_VENDOR_ORDER_NOT_FOUND", "The schedule order was not found.");
    if (selected.rowCount !== 1) throw failure(409, "SCM_VENDOR_ORDER_AMBIGUOUS", "Resolve the duplicate schedule reference before completing this order.");
    const schedule = selected.rows[0];
    const retainedRef = String(schedule.order_ref);
    const existing = await query(
      `SELECT id FROM dispatch_order_completion_events
        WHERE order_kind=$1 AND lower(order_ref)=lower($2) AND completion_evidence_type='scm_vendor'
        LIMIT 1`, [kind, retainedRef]
    );
    if (existing.rowCount) return { completed: true, idempotent: true, orderRef: retainedRef, completionEventId: String(existing.rows[0].id) };
    if (String(schedule.method).trim().toLowerCase() !== "vendor") {
      throw failure(409, "SCM_VENDOR_METHOD_REQUIRED", "Only orders with the saved Vendor method can be completed here.");
    }
    // PostgreSQL compares its full timestamp precision; browsers may hold either
    // an exact database revision or the millisecond timestamp returned by pg.
    const exactRevision = /\.\d{4,}(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(revision);
    const currentRevision = await query(
      `SELECT CASE WHEN $3::boolean THEN updated_at=$2::timestamptz
              ELSE date_trunc('milliseconds',updated_at)=$2::timestamptz END AS matches
         FROM scm_transport_schedule WHERE id=$1`, [schedule.id, revision, exactRevision]
    );
    if (!currentRevision.rows[0]?.matches) throw failure(409, "SCM_VENDOR_STALE", "This order changed after it was opened. Refresh and try again.");
    if (["cancelled", "canceled", "closed"].includes(String(schedule.status).trim().toLowerCase()) || schedule.reconciliation_blocked) {
      throw failure(409, "SCM_VENDOR_ORDER_BLOCKED", "Resolve the order's cancellation or reconciliation review before completing it.");
    }
    await assertSourceExists(kind, retainedRef);
    const evidence = await query(
      `SELECT dispatch_record_order_completion($1,$2,now(),'scm_vendor',$3,
         NULL,NULL,NULL,'operator',$4,'Vendor delivery completed in SCM.',
         '{"netSuiteUpdated":false,"method":"Vendor","source":"scm"}'::jsonb) AS id`,
      [kind, retainedRef, `scm-vendor:${schedule.id}`, actorId]
    );
    await query(
      `UPDATE scm_transport_schedule SET status='Completed',updated_by=$2,updated_at=now() WHERE id=$1`,
      [schedule.id, actorId]
    );
    return { completed: true, idempotent: false, orderRef: retainedRef, completionEventId: String(evidence.rows[0].id) };
  });
}
