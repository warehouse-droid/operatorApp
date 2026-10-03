// @ts-check

import { query, withTransaction } from "./db.js";
import { assertNoClosedNetSuiteOrders } from "./netsuite-closed-order-repository.js";

const ORDER_KINDS = new Set(["SO", "TO", "PO", "VRMA", "CUSTOM"]);

/**
 * @typedef {object} DispatchOrderCompletionStatus
 * @property {string} completionEventId
 * @property {string} orderKind
 * @property {string} orderRef
 * @property {string} dispatchCompletionStatus
 * @property {string} dispatchCompletedAt
 * @property {string} completionEvidenceType
 * @property {string} completionEvidenceId
 * @property {string | null} planId
 * @property {string | null} planDate
 * @property {string | null} loadId
 * @property {string} actorType
 * @property {string} actorId
 * @property {string} reason
 */

/** @param {number} status @param {string} code @param {string} message */
function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} value */
function normalizedKind(value) {
  const retained = text(value).toUpperCase().replaceAll(/[^A-Z]/gu, "_");
  const kind = /** @type {Record<string, string | undefined>} */ ({
    SO: "SO",
    SALES_ORDER: "SO",
    TO: "TO",
    TRANSFER_ORDER: "TO",
    PO: "PO",
    PURCHASE_ORDER: "PO",
    VRMA: "VRMA",
    VENDOR_RETURN_AUTHORIZATION: "VRMA",
    CUSTOM: "CUSTOM",
    CUSTOM_ORDER: "CUSTOM"
  })[retained];
  if (!kind || !ORDER_KINDS.has(kind)) {
    throw failure(400, "DISPATCH_COMPLETION_ORDER_KIND_INVALID", "Choose SO, TO, PO, VRMA, or CUSTOM.");
  }
  return kind;
}

/** @param {unknown} value */
function orderReference(value) {
  const retained = text(value);
  if (!retained || retained.length > 200) {
    throw failure(400, "DISPATCH_COMPLETION_ORDER_REF_INVALID", "A valid Dispatch order reference is required.");
  }
  return retained;
}

/** @param {unknown} value */
function completionReason(value) {
  const retained = text(value);
  if (!retained) {
    throw failure(400, "DISPATCH_COMPLETION_REASON_REQUIRED", "Explain why this Driver completion is being recovered manually.");
  }
  if (retained.length > 1000) {
    throw failure(400, "DISPATCH_COMPLETION_REASON_INVALID", "The manual completion reason must be 1000 characters or fewer.");
  }
  return retained;
}

/** @param {unknown} value */
function completionTimestamp(value) {
  const retained = text(value);
  const parsed = retained ? new Date(retained) : new Date();
  if (!Number.isFinite(parsed.getTime())) {
    throw failure(400, "DISPATCH_COMPLETION_TIME_INVALID", "Choose a valid completion date and time.");
  }
  return parsed.toISOString();
}

/** @param {unknown} value */
function completionActor(value) {
  const actor = value && typeof value === "object"
    ? /** @type {Record<string, any>} */ (value)
    : {};
  const operatorId = text(actor.operatorId || actor.id);
  const roles = [...new Set([
    ...(Array.isArray(actor.roles) ? actor.roles : []),
    actor.role
  ].map((role) => text(role).toLowerCase().replaceAll(/[- ]/gu, "_")).filter(Boolean))];
  if (!operatorId || !roles.some((role) => ["admin", "dispatcher"].includes(role))) {
    throw failure(403, "DISPATCH_COMPLETION_FORBIDDEN", "A Dispatcher or Admin account is required.");
  }
  return { operatorId, roles };
}

/** @param {Record<string, any>} row @returns {DispatchOrderCompletionStatus} */
function publicCompletion(row) {
  return {
    completionEventId: text(row.completion_event_id),
    orderKind: text(row.order_kind),
    orderRef: text(row.order_ref),
    dispatchCompletionStatus: text(row.dispatch_completion_status),
    dispatchCompletedAt: new Date(row.dispatch_completed_at).toISOString(),
    completionEvidenceType: text(row.completion_evidence_type),
    completionEvidenceId: text(row.completion_evidence_id),
    planId: row.plan_id === null ? null : text(row.plan_id),
    planDate: row.plan_date === null ? null : text(row.plan_date),
    loadId: row.load_id === null ? null : text(row.load_id),
    actorType: text(row.actor_type),
    actorId: text(row.actor_id),
    reason: text(row.reason)
  };
}

/**
 * Read canonical Dispatch completion for a bounded order feed without
 * interpreting any source-specific operational status.
 *
 * @param {Array<{orderKind: unknown, orderRef: unknown}>} requests
 * @returns {Promise<DispatchOrderCompletionStatus[]>}
 */
export async function listDispatchOrderCompletionStatuses(requests) {
  const unique = new Map();
  for (const request of Array.isArray(requests) ? requests : []) {
    try {
      const kind = normalizedKind(request?.orderKind);
      const reference = orderReference(request?.orderRef);
      unique.set(`${kind}|${reference.toUpperCase()}`, { orderKind: kind, orderRef: reference });
    } catch {
      // Dispatch feeds may contain non-order helper rows. Unsupported rows do
      // not receive a completion status and must not break the whole feed.
    }
  }
  if (unique.size === 0) return [];
  const result = await query(
    `WITH requested AS (
       SELECT upper(btrim(item->>'orderKind')) AS order_kind,
              btrim(item->>'orderRef') AS order_ref
         FROM jsonb_array_elements($1::jsonb) item
     )
     SELECT completion.completion_event_id,
            completion.order_kind,
            completion.order_ref,
            completion.dispatch_completion_status,
            completion.dispatch_completed_at,
            completion.completion_evidence_type,
            completion.completion_evidence_id,
            completion.plan_id,
            completion.plan_date,
            completion.load_id,
            completion.actor_type,
            completion.actor_id,
            completion.reason
       FROM requested
       JOIN dispatch_order_completion_status completion
         ON completion.order_kind = requested.order_kind
        AND lower(btrim(completion.order_ref)) = lower(btrim(requested.order_ref))
      ORDER BY completion.order_kind, lower(btrim(completion.order_ref))`,
    [JSON.stringify([...unique.values()])]
  );
  return result.rows.map(publicCompletion);
}

/** @param {Record<string, any>} order */
function projectedOrderKind(order = {}) {
  if (text(order.sourceTable) === "scm_vrma_orders") return "VRMA";
  try {
    return normalizedKind(order.type || order.orderKind);
  } catch {
    return "";
  }
}

/** @param {Record<string, any>} order */
function projectedOrderReference(order = {}) {
  return text(order.id || order.orderId || order.orderRef || order.tranid || order.refNumber);
}

/**
 * Overlay the immutable completion projection at read time. Source operational
 * fields remain retained, while an SCM status shown by Dispatch receives the
 * terminal projection so an earlier pickup/transit phase cannot look current.
 *
 * @param {Array<Record<string, any>>} orders
 */
export async function overlayDispatchOrderCompletionStatuses(orders = []) {
  const sourceOrders = Array.isArray(orders) ? orders : [];
  if (!sourceOrders.length) return [];
  const completions = await listDispatchOrderCompletionStatuses(sourceOrders.map((order) => ({
    orderKind: projectedOrderKind(order),
    orderRef: projectedOrderReference(order)
  })));
  const byKey = new Map(completions.map((completion) => [
    `${completion.orderKind}|${text(completion.orderRef).toUpperCase()}`,
    completion
  ]));
  return sourceOrders.map((order) => {
    const kind = projectedOrderKind(order);
    const reference = projectedOrderReference(order);
    const completion = byKey.get(`${kind}|${reference.toUpperCase()}`);
    if (!completion) return order;
    if (
      order.dispatchReconciliationPlanningEligible === true
      && completion.completionEvidenceType.toLowerCase() === "reconciliation"
    ) {
      return {
        ...order,
        dispatchCompletionStatus: "",
        dispatchCompletedAt: "",
        completionEvidenceType: "",
        completionEvidenceId: "",
        completionEventId: "",
        reconciliationCompletionProjected: true,
        reconciliationCompletedAt: completion.dispatchCompletedAt,
        reconciliationCompletionEvidenceId: completion.completionEvidenceId
      };
    }
    const scm = order.scm && typeof order.scm === "object" && !Array.isArray(order.scm)
      ? { ...order.scm, status: "Completed" }
      : null;
    return {
      ...order,
      ...(scm ? { scm } : {}),
      ...(kind === "PO" && completion.completionEvidenceType === "driver_job" ? {
        dispatchPlanningRestricted: true,
        dispatchPlanningRestrictionReason: `${reference} was completed in Driver PWA and cannot be planned again.`
      } : {}),
      dispatchCompletionStatus: completion.dispatchCompletionStatus,
      dispatchCompletedAt: completion.dispatchCompletedAt,
      completionEvidenceType: completion.completionEvidenceType,
      completionEvidenceId: completion.completionEvidenceId,
      completionEventId: completion.completionEventId
    };
  });
}

/** @param {string} kind @param {string} reference */
async function assertOrderExists(kind, reference) {
  /** @type {Record<string, string>} */
  const statements = {
    SO: `SELECT netsuite_id::text AS id, tranid AS retained_ref, false AS cancelled
           FROM sales_orders
          WHERE lower(btrim(tranid)) = lower(btrim($1))
          LIMIT 1
          FOR SHARE`,
    TO: `SELECT netsuite_id::text AS id, tranid AS retained_ref, false AS cancelled
           FROM transfer_orders
          WHERE lower(btrim(tranid)) = lower(btrim($1))
          LIMIT 1
          FOR SHARE`,
    PO: `SELECT purchase.netsuite_id::text AS id,
                COALESCE(NULLIF(btrim(split.split_po_ref), ''),
                         NULLIF(btrim(purchase.dispatch_ref), ''),
                         purchase.tranid) AS retained_ref,
                false AS cancelled
           FROM purchase_orders purchase
           LEFT JOIN dispatch_scm_po_splits split
             ON split.status = 'active'
            AND split.split_po_id = purchase.netsuite_id
          WHERE lower(btrim(purchase.tranid)) = lower(btrim($1))
             OR lower(btrim(COALESCE(purchase.dispatch_ref, ''))) = lower(btrim($1))
             OR lower(btrim(COALESCE(purchase.vendor_reference, ''))) = lower(btrim($1))
             OR lower(btrim(COALESCE(split.split_po_ref, ''))) = lower(btrim($1))
          ORDER BY split.id DESC NULLS LAST
          LIMIT 1
          FOR SHARE OF purchase`,
    VRMA: `SELECT id::text, vrma_ref AS retained_ref,
                  lower(btrim(COALESCE(status, ''))) = 'cancelled' AS cancelled
             FROM scm_vrma_orders
            WHERE lower(btrim(vrma_ref)) = lower(btrim($1))
            LIMIT 1
            FOR SHARE`,
    CUSTOM: `SELECT id::text, ref_number AS retained_ref,
                    status = 'cancelled' AS cancelled
               FROM dispatch_custom_orders
              WHERE lower(btrim(ref_number)) = lower(btrim($1))
              LIMIT 1
              FOR SHARE`
  };
  const result = await query(statements[kind], [reference]);
  if (!result.rowCount) {
    throw failure(404, "DISPATCH_COMPLETION_ORDER_NOT_FOUND", "The Dispatch order reference was not found.");
  }
  if (result.rows[0].cancelled === true) {
    throw failure(409, "DISPATCH_COMPLETION_ORDER_CANCELLED", "A cancelled Dispatch order cannot be marked completed.");
  }
  return result.rows[0];
}

/** @param {string} kind @param {string} reference */
async function canonicalCompletion(kind, reference) {
  const result = await query(
    `SELECT completion_event_id, order_kind, order_ref,
            dispatch_completion_status, dispatch_completed_at,
            completion_evidence_type, completion_evidence_id,
            plan_id, plan_date, load_id,
            actor_type, actor_id, reason
       FROM dispatch_order_completion_status
      WHERE order_kind = $1
        AND lower(btrim(order_ref)) = lower(btrim($2))
      LIMIT 1`,
    [kind, reference]
  );
  return result.rowCount ? publicCompletion(result.rows[0]) : null;
}

/**
 * Recover a Driver completion that was not submitted from the PWA. This does
 * not write driver_job_records; the immutable evidence remains explicitly
 * manual and auditable.
 *
 * @param {unknown} rawInput
 */
export async function manuallyCompleteDispatchOrder(rawInput) {
  const input = rawInput && typeof rawInput === "object"
    ? /** @type {Record<string, any>} */ (rawInput)
    : {};
  const actor = completionActor(input.actor);
  if (input.confirm !== true) {
    throw failure(
      400,
      "DISPATCH_COMPLETION_CONFIRMATION_REQUIRED",
      "Confirm that the Driver completed this order before recording manual completion."
    );
  }
  const kind = normalizedKind(input.orderKind);
  const reference = orderReference(input.orderRef);
  const reason = completionReason(input.reason);
  const completedAt = completionTimestamp(input.completedAt);
  await assertNoClosedNetSuiteOrders([reference], "be manually completed in Dispatch");

  return withTransaction(async () => {
    await assertOrderExists(kind, reference);
    const existing = await canonicalCompletion(kind, reference);
    if (existing) {
      return existing;
    }
    const evidenceId = `manual:${kind}:${reference.toUpperCase()}`;
    await query(
      `SELECT dispatch_record_order_completion(
         $1, $2, $3::timestamptz, 'manual_dispatch', $4,
         NULL, NULL, NULL, 'operator', $5, $6, $7::jsonb
       )`,
      [
        kind,
        reference,
        completedAt,
        evidenceId,
        actor.operatorId,
        reason,
        JSON.stringify({ recoveredDriverCompletion: true })
      ]
    );
    const completed = await canonicalCompletion(kind, reference);
    if (!completed) {
      throw failure(500, "DISPATCH_COMPLETION_WRITE_FAILED", "The manual Dispatch completion could not be retained.");
    }
    return completed;
  });
}
