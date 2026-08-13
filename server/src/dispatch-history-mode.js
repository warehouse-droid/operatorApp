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
     latest_sales_order_apply AS (
       SELECT DISTINCT ON (event.parent_order_netsuite_id)
              event.parent_order_netsuite_id,
              event.parent_order_ref,
              event.payload
         FROM scm_reconciliation_audit_events event
        WHERE event.record_type = 'SO'
          AND event.parent_order_kind = 'SO'
          AND event.parent_order_netsuite_id IS NOT NULL
          AND event.action = 'apply'
          AND event.validation_status = 'accepted'
        ORDER BY event.parent_order_netsuite_id,
                 COALESCE(event.occurred_at, event.received_at, event.created_at) DESC,
                 event.id DESC
     ),
     completed_sales_order_apply AS (
       SELECT latest.parent_order_netsuite_id,
              latest.parent_order_ref,
              latest.payload,
              sales.tranid
         FROM latest_sales_order_apply latest
         JOIN sales_orders sales
           ON sales.netsuite_id = latest.parent_order_netsuite_id
        WHERE LOWER(BTRIM(COALESCE(latest.payload->>'applicationStatus', ''))) IN ('complete', 'completed')
          AND LOWER(BTRIM(COALESCE(latest.payload->>'reconciliationStatus', ''))) IN ('current', 'ok')
          AND LOWER(BTRIM(COALESCE(latest.payload->>'dryRun', 'false'))) NOT IN ('true', '1', 'yes')
          AND sales.netsuite_active = false
          AND LOWER(BTRIM(COALESCE(sales.fulfillment_status, ''))) = 'fulfilled'
     ),
     completed_sales_order_refs AS (
       SELECT completed.parent_order_ref AS value
         FROM completed_sales_order_apply completed
       UNION ALL
       SELECT completed.tranid
         FROM completed_sales_order_apply completed
       UNION ALL
       SELECT completed.payload->>'sourceOrderRef'
         FROM completed_sales_order_apply completed
       UNION ALL
       SELECT family_ref.value
         FROM completed_sales_order_apply completed
         CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
           CASE
             WHEN JSONB_TYPEOF(completed.payload->'familyOrderRefs') = 'array'
               THEN completed.payload->'familyOrderRefs'
             ELSE '[]'::jsonb
           END
         ) family_ref(value)
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
       UNION ALL
       SELECT completed.value
         FROM completed_sales_order_refs completed
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
    `WITH RECURSIVE group_relations AS (
       SELECT DISTINCT LOWER(BTRIM(raw.parent_ref)) AS parent_ref,
                       LOWER(BTRIM(raw.child_ref)) AS child_ref
         FROM (
           SELECT group_row.group_ref AS parent_ref,
                  member.member_order_ref AS child_ref
             FROM dispatch_delivery_groups group_row
             JOIN dispatch_delivery_group_members member ON member.group_ref = group_row.group_ref
            WHERE group_row.active = true
           UNION ALL
           SELECT group_row.group_ref AS parent_ref,
                  member.order_ref AS child_ref
             FROM scm_schedule_groups group_row
             JOIN scm_schedule_group_members member ON member.group_id = group_row.id
            WHERE LOWER(BTRIM(COALESCE(group_row.status, ''))) = 'active'
         ) raw
        WHERE COALESCE(BTRIM(raw.parent_ref), '') <> ''
          AND COALESCE(BTRIM(raw.child_ref), '') <> ''
     ),
     split_relations AS (
       SELECT DISTINCT LOWER(BTRIM(raw.parent_ref)) AS parent_ref,
                       LOWER(BTRIM(raw.child_ref)) AS child_ref
         FROM (
           SELECT source_po_ref AS parent_ref,
                  split_po_ref AS child_ref
             FROM dispatch_scm_po_splits
            WHERE LOWER(BTRIM(COALESCE(status, ''))) = 'active'
           UNION ALL
           SELECT source_to_ref AS parent_ref,
                  split_to_ref AS child_ref
             FROM dispatch_scm_to_splits
            WHERE LOWER(BTRIM(COALESCE(status, ''))) = 'active'
           UNION ALL
           SELECT source_so_ref AS parent_ref,
                  split_so_ref AS child_ref
             FROM dispatch_scm_so_splits
            WHERE LOWER(BTRIM(COALESCE(status, ''))) = 'active'
         ) raw
        WHERE COALESCE(BTRIM(raw.parent_ref), '') <> ''
          AND COALESCE(BTRIM(raw.child_ref), '') <> ''
     ),
     completion_edges(from_ref, to_ref) AS (
       SELECT parent_ref, child_ref
         FROM group_relations
       UNION
       SELECT child_ref, parent_ref
         FROM group_relations
       UNION
       SELECT parent_ref, child_ref
         FROM split_relations
     ),
     candidate_sources(order_ref) AS (
       SELECT UNNEST($1::text[])
       UNION
       SELECT edge.from_ref
         FROM candidate_sources candidate
         JOIN completion_edges edge ON edge.to_ref = candidate.order_ref
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
            OR LOWER(BTRIM(ref.value)) IN (SELECT order_ref FROM candidate_sources)
          )
     ),
     completed_closure(order_ref) AS (
       SELECT order_ref
         FROM driver_completed
       UNION
       SELECT edge.to_ref
         FROM completed_closure completed
         JOIN completion_edges edge ON edge.from_ref = completed.order_ref
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

export async function assertHistoricalInactiveSalesOrdersReconciled({
  planDate = "",
  orderRefs = [],
  action = "plan these orders"
} = {}) {
  if (!historicalDispatchPlanDate(planDate)) return true;
  const requested = [...new Set((orderRefs || []).map(refKey).filter(Boolean))];
  if (!requested.length) return true;
  const result = await query(
    `WITH RECURSIVE raw_relations AS (
       SELECT member.group_ref AS parent_ref,
              member.member_order_ref AS child_ref
         FROM dispatch_delivery_group_members member
         JOIN dispatch_delivery_groups group_row
           ON group_row.group_ref = member.group_ref
          AND group_row.active = true
          AND group_row.order_type = 'sales_order'
       UNION ALL
       SELECT split.source_so_ref AS parent_ref,
              split.split_so_ref AS child_ref
         FROM dispatch_scm_so_splits split
        WHERE split.status = 'active'
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
     )
     SELECT DISTINCT LOWER(BTRIM(sales.tranid)) AS order_ref
       FROM sales_orders sales
      WHERE sales.netsuite_active = false
        AND LOWER(BTRIM(sales.tranid)) IN (SELECT order_ref FROM candidate_closure)`,
    [requested]
  );
  const inactiveRefs = result.rows.map((row) => refKey(row.order_ref)).filter(Boolean);
  if (!inactiveRefs.length) return true;
  const completedRefs = await listCompletedReconciliationDispatchRefs();
  const conflicts = inactiveRefs
    .filter((ref) => !completedRefs.has(ref))
    .map((orderRef) => ({
      orderRef,
      reason: `${orderRef} is inactive without accepted reconciliation-complete proof.`
    }));
  if (!conflicts.length) return true;
  throw Object.assign(
    new Error(`Cannot ${action}: ${conflicts.map((item) => item.orderRef).join(", ")} is not reconciliation-complete.`),
    {
      status: 409,
      code: "DISPATCH_HISTORY_RECONCILIATION_REQUIRED",
      conflicts
    }
  );
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
