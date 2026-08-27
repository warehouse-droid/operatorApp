import { query } from "./db.js";

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("SCM status refresh time must be valid.");
  return date;
}

export async function hasActiveScmReconciliationRun() {
  const result = await query(
    `SELECT 1
       FROM scm_reconciliation_runs
      WHERE status IN ('queued', 'running')
      LIMIT 1`
  );
  return result.rowCount > 0;
}

export async function listStaleScmScheduleStatusCandidates({
  now = new Date(),
  limit = 30,
  staleAfterMs = 6 * 60 * 60 * 1000,
  recentAttemptMs = 60 * 60 * 1000
} = {}) {
  const observedAt = validDate(now);
  const boundedLimit = positiveInteger(limit, 30, 100);
  const boundedStaleAfterMs = positiveInteger(staleAfterMs, 6 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
  const boundedRecentAttemptMs = positiveInteger(recentAttemptMs, 60 * 60 * 1000, 24 * 60 * 60 * 1000);
  const result = await query(
    `WITH stale_schedule AS MATERIALIZED (
       SELECT schedule.order_kind,
              schedule.source_id,
              schedule.order_ref,
              state.source_order_netsuite_id,
              state.source_order_ref,
              state.reconciled_at,
              schedule.created_at,
              schedule.id
         FROM scm_transport_schedule schedule
         LEFT JOIN scm_reconciliation_order_state state
           ON state.id = schedule.reconciliation_order_state_id
         LEFT JOIN dispatch_order_completion_status completion
           ON completion.order_kind = schedule.order_kind
          AND completion.dispatch_completion_status = 'completed'
          AND lower(btrim(completion.order_ref)) = lower(btrim(schedule.order_ref))
        WHERE schedule.order_kind IN ('PO', 'TO')
          AND schedule.status IN ('Queued', 'Planned')
          AND schedule.reconciliation_blocked = false
          AND completion.completion_event_id IS NULL
          AND COALESCE(state.broad_reconciliation_skipped, false) = false
          AND (
            state.id IS NULL
            OR state.application_status IN ('Queued', 'Planned')
            OR schedule.updated_at > state.reconciled_at
          )
          AND (
            state.reconciled_at IS NULL
            OR state.reconciled_at <= $1::timestamptz
              - ($2::double precision * interval '1 millisecond')
          )
     ),
     aliases AS MATERIALIZED (
       SELECT stale.*,
              stale.order_ref AS alias_ref,
              0 AS alias_priority
         FROM stale_schedule stale
       UNION ALL
       SELECT stale.*,
              member.order_ref AS alias_ref,
              1 AS alias_priority
         FROM stale_schedule stale
         JOIN scm_schedule_groups group_header
           ON group_header.status = 'active'
          AND lower(group_header.group_ref) = lower(stale.order_ref)
         JOIN scm_schedule_group_members member
           ON member.group_id = group_header.id
          AND member.order_kind = stale.order_kind
     ),
     resolved AS MATERIALIZED (
       SELECT aliases.order_kind,
              authoritative.source_order_id,
              authoritative.source_order_ref AS order_ref,
              aliases.reconciled_at,
              aliases.created_at,
              aliases.id,
              aliases.alias_priority
         FROM aliases
         JOIN LATERAL (
           SELECT candidate.source_order_id,
                  candidate.source_order_ref
             FROM (
               SELECT aliases.source_order_netsuite_id AS source_order_id,
                      aliases.source_order_ref,
                      0 AS priority
                WHERE aliases.alias_priority = 0
                  AND aliases.source_order_netsuite_id > 0
                  AND NULLIF(btrim(aliases.source_order_ref), '') IS NOT NULL
               UNION ALL
               SELECT split.source_po_id,
                      split.source_po_ref,
                      1
                 FROM dispatch_scm_po_splits split
                WHERE aliases.order_kind = 'PO'
                  AND split.source_po_id > 0
                  AND lower(split.split_po_ref) = lower(aliases.alias_ref)
               UNION ALL
               SELECT split.source_to_id,
                      split.source_to_ref,
                      1
                 FROM dispatch_scm_to_splits split
                WHERE aliases.order_kind = 'TO'
                  AND split.source_to_id > 0
                  AND lower(split.split_to_ref) = lower(aliases.alias_ref)
               UNION ALL
               SELECT purchase.netsuite_id,
                      purchase.tranid,
                      2
                 FROM purchase_orders purchase
                WHERE aliases.order_kind = 'PO'
                  AND purchase.netsuite_id > 0
                  AND (
                    lower(purchase.tranid) = lower(aliases.alias_ref)
                    OR lower(COALESCE(purchase.dispatch_ref, '')) = lower(aliases.alias_ref)
                    OR (
                      aliases.alias_priority = 0
                      AND purchase.netsuite_id = COALESCE(
                        aliases.source_order_netsuite_id,
                        aliases.source_id
                      )
                    )
                  )
               UNION ALL
               SELECT transfer.netsuite_id,
                      transfer.tranid,
                      2
                 FROM transfer_orders transfer
                WHERE aliases.order_kind = 'TO'
                  AND transfer.netsuite_id > 0
                  AND (
                    lower(transfer.tranid) = lower(aliases.alias_ref)
                    OR (
                      aliases.alias_priority = 0
                      AND transfer.netsuite_id = COALESCE(
                        aliases.source_order_netsuite_id,
                        aliases.source_id
                      )
                    )
                  )
             ) candidate
            WHERE NULLIF(btrim(candidate.source_order_ref), '') IS NOT NULL
            ORDER BY candidate.priority, candidate.source_order_id
            LIMIT 1
         ) authoritative ON true
     ),
     candidates AS MATERIALIZED (
       SELECT DISTINCT ON (resolved.order_kind, resolved.source_order_id)
              resolved.order_kind,
              resolved.order_ref,
              resolved.reconciled_at,
              resolved.created_at,
              resolved.id
         FROM resolved
        WHERE NOT EXISTS (
            SELECT 1
              FROM scm_reconciliation_runs recent
             CROSS JOIN LATERAL unnest(
               string_to_array(COALESCE(recent.target_order_ref, ''), ',')
             ) target(order_ref)
             WHERE recent.scope_kind = 'order_family'
               AND recent.target_order_kind = resolved.order_kind
               AND lower(btrim(target.order_ref)) = lower(btrim(resolved.order_ref))
               AND recent.created_at > $1::timestamptz
                 - ($3::double precision * interval '1 millisecond')
          )
        ORDER BY resolved.order_kind,
                 resolved.source_order_id,
                 resolved.reconciled_at NULLS FIRST,
                 resolved.created_at,
                 resolved.id,
                 resolved.alias_priority
     )
     SELECT order_kind, order_ref
       FROM candidates
      ORDER BY reconciled_at NULLS FIRST, created_at, id
      LIMIT $4`,
    [observedAt, boundedStaleAfterMs, boundedRecentAttemptMs, boundedLimit]
  );
  return result.rows.map((row) => ({
    orderKind: row.order_kind,
    orderRef: row.order_ref
  }));
}
