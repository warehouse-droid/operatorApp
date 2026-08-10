import { query } from "./db.js";

const DISPATCH_COMPANY_TIME_ZONE = "America/Toronto";

function text(value) {
  return String(value ?? "").trim();
}

function refKey(value) {
  return text(value).toLowerCase();
}

export function dispatchCompanyDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPATCH_COMPANY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function historicalDispatchPlanDate(value, { today = dispatchCompanyDate() } = {}) {
  const candidate = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return "";
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) return "";
  return candidate < today ? candidate : "";
}

export async function listCompletedReconciliationDispatchRefs() {
  const result = await query(
    `WITH eligible_state AS (
       SELECT state.id,
              state.order_kind,
              state.source_order_netsuite_id,
              state.source_order_ref,
              state.application_status,
              state.quantity_summary
         FROM scm_reconciliation_order_state state
        WHERE state.reconciled_at IS NOT NULL
          AND state.order_kind IN ('PO', 'TO')
          AND (
            state.order_kind <> 'PO'
            OR NOT EXISTS (
              SELECT 1
                FROM purchase_orders blanket_po
               WHERE blanket_po.is_blanket_po = true
                 AND (
                   blanket_po.netsuite_id = state.source_order_netsuite_id
                   OR LOWER(BTRIM(blanket_po.tranid)) = LOWER(BTRIM(state.source_order_ref))
                   OR LOWER(BTRIM(COALESCE(NULLIF(blanket_po.dispatch_ref, ''), blanket_po.tranid))) = LOWER(BTRIM(state.source_order_ref))
                 )
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM scm_transport_schedule non_mbt
             WHERE UPPER(BTRIM(COALESCE(non_mbt.method, 'MBT'))) <> 'MBT'
               AND (
                 non_mbt.reconciliation_order_state_id = state.id
                 OR (
                   non_mbt.order_kind = state.order_kind
                   AND (
                     non_mbt.source_id = state.source_order_netsuite_id
                     OR LOWER(BTRIM(non_mbt.order_ref)) = LOWER(BTRIM(state.source_order_ref))
                     OR LOWER(BTRIM(COALESCE(non_mbt.display_ref, ''))) = LOWER(BTRIM(state.source_order_ref))
                   )
                 )
               )
          )
     ),
     completed_family AS (
       SELECT state.id,
              state.order_kind,
              state.source_order_netsuite_id,
              state.source_order_ref
         FROM eligible_state state
        WHERE LOWER(BTRIM(COALESCE(state.application_status, ''))) IN ('complete', 'completed')
     ),
     completed_target AS (
       SELECT state.order_kind,
              state.source_order_netsuite_id,
              target.target_ref
         FROM eligible_state state
         CROSS JOIN LATERAL JSONB_EACH(
           CASE
             WHEN JSONB_TYPEOF(state.quantity_summary->'targets') = 'object'
               THEN state.quantity_summary->'targets'
           ELSE '{}'::jsonb
           END
         ) target(target_ref, target_state)
        WHERE LOWER(BTRIM(COALESCE(target.target_state->>'applicationStatus', ''))) IN ('complete', 'completed')
     ),
     completed_refs AS (
       SELECT family.source_order_ref AS value
         FROM completed_family family
       UNION ALL
       SELECT po.tranid
         FROM completed_family family
         JOIN purchase_orders po
           ON family.order_kind = 'PO'
          AND po.netsuite_id = family.source_order_netsuite_id
       UNION ALL
       SELECT po.dispatch_ref
         FROM completed_family family
         JOIN purchase_orders po
           ON family.order_kind = 'PO'
          AND po.netsuite_id = family.source_order_netsuite_id
       UNION ALL
       SELECT transfer.tranid
         FROM completed_family family
         JOIN transfer_orders transfer
           ON family.order_kind = 'TO'
          AND transfer.netsuite_id = family.source_order_netsuite_id
       UNION ALL
       SELECT schedule.order_ref
         FROM completed_family family
         JOIN scm_transport_schedule schedule
           ON schedule.reconciliation_order_state_id = family.id
       UNION ALL
       SELECT schedule.display_ref
         FROM completed_family family
         JOIN scm_transport_schedule schedule
           ON schedule.reconciliation_order_state_id = family.id
       UNION ALL
       SELECT target.target_ref
         FROM completed_target target
       UNION ALL
       SELECT po.tranid
         FROM completed_target target
         JOIN purchase_orders po
           ON target.order_kind = 'PO'
          AND LOWER(BTRIM(target.target_ref)) IN (
            LOWER(BTRIM(po.tranid)),
            LOWER(BTRIM(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)))
          )
       UNION ALL
       SELECT po.dispatch_ref
         FROM completed_target target
         JOIN purchase_orders po
           ON target.order_kind = 'PO'
          AND LOWER(BTRIM(target.target_ref)) IN (
            LOWER(BTRIM(po.tranid)),
            LOWER(BTRIM(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)))
          )
       UNION ALL
       SELECT transfer.tranid
         FROM completed_target target
         JOIN transfer_orders transfer
           ON target.order_kind = 'TO'
          AND LOWER(BTRIM(target.target_ref)) = LOWER(BTRIM(transfer.tranid))
     ),
     normalized_completed_refs AS (
       SELECT DISTINCT LOWER(BTRIM(value)) AS order_ref
         FROM completed_refs
        WHERE COALESCE(BTRIM(value), '') <> ''
     ),
     completed_groups AS (
       SELECT group_row.group_ref AS value
         FROM scm_schedule_groups group_row
         JOIN scm_schedule_group_members member ON member.group_id = group_row.id
        WHERE group_row.status = 'active'
        GROUP BY group_row.id, group_row.group_ref
       HAVING BOOL_AND(LOWER(BTRIM(member.order_ref)) IN (
         SELECT order_ref FROM normalized_completed_refs
       ))
     )
     SELECT order_ref
       FROM normalized_completed_refs
     UNION
     SELECT LOWER(BTRIM(value)) AS order_ref
       FROM completed_groups
      WHERE COALESCE(BTRIM(value), '') <> ''`
  );
  return new Set(result.rows.map((row) => refKey(row.order_ref)).filter(Boolean));
}

export async function listDriverPwaCompletedDispatchRefs({ candidateRefs = [] } = {}) {
  const requested = [...new Set((candidateRefs || []).map(refKey).filter(Boolean))];
  const result = await query(
    `WITH RECURSIVE raw_relations AS (
       SELECT group_ref AS parent_ref,
              member_order_ref AS child_ref
         FROM dispatch_delivery_group_members
       UNION ALL
       SELECT group_row.group_ref AS parent_ref,
              member.order_ref AS child_ref
         FROM scm_schedule_groups group_row
         JOIN scm_schedule_group_members member ON member.group_id = group_row.id
       UNION ALL
       SELECT source_po_ref AS parent_ref,
              split_po_ref AS child_ref
         FROM dispatch_scm_po_splits
       UNION ALL
       SELECT source_to_ref AS parent_ref,
              split_to_ref AS child_ref
         FROM dispatch_scm_to_splits
       UNION ALL
       SELECT source_so_ref AS parent_ref,
              split_so_ref AS child_ref
         FROM dispatch_scm_so_splits
     ),
     relations AS (
       SELECT DISTINCT LOWER(BTRIM(parent_ref)) AS parent_ref,
                       LOWER(BTRIM(child_ref)) AS child_ref
         FROM raw_relations
        WHERE COALESCE(BTRIM(parent_ref), '') <> ''
          AND COALESCE(BTRIM(child_ref), '') <> ''
     ),
     candidate_closure(order_ref) AS (
       SELECT UNNEST($1::text[])
       UNION
       SELECT CASE
                WHEN relation.parent_ref = candidate.order_ref THEN relation.child_ref
                ELSE relation.parent_ref
              END
         FROM candidate_closure candidate
         JOIN relations relation
           ON relation.parent_ref = candidate.order_ref
           OR relation.child_ref = candidate.order_ref
     ),
     driver_completed AS (
       SELECT DISTINCT LOWER(BTRIM(ref.value)) AS order_ref
         FROM driver_job_records record
         CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
           CASE
             WHEN JSONB_TYPEOF(record.order_refs) = 'array' THEN record.order_refs
             ELSE '[]'::jsonb
           END
         ) ref(value)
        WHERE LOWER(BTRIM(COALESCE(record.status, ''))) IN ('complete', 'completed')
          AND COALESCE(BTRIM(ref.value), '') <> ''
          AND (
            $2::boolean
            OR LOWER(BTRIM(ref.value)) IN (SELECT order_ref FROM candidate_closure)
          )
     ),
     completed_closure(order_ref) AS (
       SELECT order_ref
         FROM driver_completed
       UNION
       SELECT CASE
                WHEN relation.parent_ref = completed.order_ref THEN relation.child_ref
                ELSE relation.parent_ref
              END
         FROM completed_closure completed
         JOIN relations relation
           ON relation.parent_ref = completed.order_ref
           OR relation.child_ref = completed.order_ref
     )
     SELECT order_ref
       FROM completed_closure`,
    [requested, requested.length === 0]
  );
  return new Set(result.rows.map((row) => refKey(row.order_ref)).filter(Boolean));
}

export async function historicalReconciliationDispatchAllowance({ planDate = "", orderRefs = [] } = {}) {
  if (!historicalDispatchPlanDate(planDate)) return new Set();
  const requested = new Set((orderRefs || []).map(refKey).filter(Boolean));
  if (!requested.size) return new Set();
  const completedRefs = await listCompletedReconciliationDispatchRefs();
  return new Set([...requested].filter((ref) => completedRefs.has(ref)));
}

export async function assertNoDriverPwaCompletedDispatchRefs(orderRefs = [], action = "plan this order") {
  const requested = [...new Set((orderRefs || []).map(refKey).filter(Boolean))];
  if (!requested.length) return true;
  const completedRefs = await listDriverPwaCompletedDispatchRefs({ candidateRefs: requested });
  const conflicts = requested
    .filter((ref) => completedRefs.has(ref))
    .map((orderRef) => ({
      orderRef,
      reason: `${orderRef} was completed in Driver PWA and cannot be planned again.`
    }));
  if (!conflicts.length) return true;
  throw Object.assign(
    new Error(`Cannot ${action}: ${conflicts.map((item) => item.orderRef).join(", ")} was completed in Driver PWA.`),
    {
      status: 409,
      code: "DISPATCH_ORDER_DRIVER_COMPLETED",
      conflicts
    }
  );
}
