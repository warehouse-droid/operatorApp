import { query } from "./db.js";
import {
  exactNetSuiteClosedSql,
  normalizeNetSuiteOrderRefs,
  operationalPlanOrderRefs,
  scrubOrderRefsFromOperationalPlan
} from "./netsuite-closed-order-policy.js";

export class NetSuiteClosedOrderError extends Error {
  constructor(conflicts = [], action = "change this order") {
    const refs = conflicts.map((entry) => entry.requestedRef || entry.canonicalRef).filter(Boolean);
    super(`NetSuite has Closed ${refs.join(", ") || "this order"}; it cannot ${action}.`);
    this.name = "NetSuiteClosedOrderError";
    this.code = "NETSUITE_ORDER_CLOSED";
    this.status = 409;
    this.conflicts = conflicts;
  }
}

export async function listClosedNetSuiteOrders(orderRefs = []) {
  const refs = normalizeNetSuiteOrderRefs(orderRefs);
  if (!refs.length) return [];
  const result = await query(
    `WITH requested(requested_ref, numeric_id) AS (
       SELECT normalized.requested_ref,
              CASE
                WHEN normalized.requested_ref ~ '^-?[0-9]{1,19}$'
                 AND normalized.requested_ref::numeric BETWEEN
                       -9223372036854775808::numeric AND 9223372036854775807::numeric
                THEN normalized.requested_ref::bigint
                ELSE NULL
              END AS numeric_id
         FROM (
           SELECT DISTINCT UPPER(BTRIM(value)) AS requested_ref
             FROM unnest($1::text[]) input(value)
            WHERE BTRIM(value) <> ''
         ) normalized
     ),
     so_candidates AS (
       SELECT requested.requested_ref, candidate.netsuite_id AS candidate_id
         FROM requested
         JOIN sales_orders candidate
           ON upper(BTRIM(candidate.tranid)) = requested.requested_ref
       UNION
       SELECT requested.requested_ref, candidate.netsuite_id AS candidate_id
         FROM requested
         JOIN sales_orders candidate ON candidate.netsuite_id = requested.numeric_id
        WHERE requested.numeric_id IS NOT NULL
     ),
     so_resolved AS (
       SELECT DISTINCT candidate.requested_ref,
              COALESCE(membership.source_so_id, candidate.candidate_id) AS source_id
         FROM so_candidates candidate
         LEFT JOIN dispatch_scm_so_splits membership
           ON membership.split_so_id = candidate.candidate_id
       UNION
       SELECT requested.requested_ref, membership.source_so_id
         FROM requested
         JOIN dispatch_scm_so_splits membership
           ON upper(BTRIM(membership.source_so_ref)) = requested.requested_ref
       UNION
       SELECT requested.requested_ref, membership.source_so_id
         FROM requested
         JOIN dispatch_scm_so_splits membership
           ON upper(BTRIM(membership.split_so_ref)) = requested.requested_ref
     ),
     po_candidates AS (
       SELECT requested.requested_ref, candidate.netsuite_id AS candidate_id
         FROM requested
         JOIN purchase_orders candidate
           ON upper(BTRIM(candidate.tranid)) = requested.requested_ref
       UNION
       SELECT requested.requested_ref, candidate.netsuite_id AS candidate_id
         FROM requested
         JOIN purchase_orders candidate
           ON upper(BTRIM(candidate.dispatch_ref)) = requested.requested_ref
       UNION
       SELECT requested.requested_ref, candidate.netsuite_id AS candidate_id
         FROM requested
         JOIN purchase_orders candidate ON candidate.netsuite_id = requested.numeric_id
        WHERE requested.numeric_id IS NOT NULL
     ),
     po_resolved AS (
       SELECT DISTINCT candidate.requested_ref,
              COALESCE(membership.source_po_id, candidate.candidate_id) AS source_id
         FROM po_candidates candidate
         LEFT JOIN dispatch_scm_po_splits membership
           ON membership.split_po_id = candidate.candidate_id
       UNION
       SELECT requested.requested_ref, membership.source_po_id
         FROM requested
         JOIN dispatch_scm_po_splits membership
           ON upper(BTRIM(membership.source_po_ref)) = requested.requested_ref
       UNION
       SELECT requested.requested_ref, membership.source_po_id
         FROM requested
         JOIN dispatch_scm_po_splits membership
           ON upper(BTRIM(membership.split_po_ref)) = requested.requested_ref
     ),
     to_candidates AS (
       SELECT requested.requested_ref, candidate.netsuite_id AS candidate_id
         FROM requested
         JOIN transfer_orders candidate
           ON upper(BTRIM(candidate.tranid)) = requested.requested_ref
       UNION
       SELECT requested.requested_ref, candidate.netsuite_id AS candidate_id
         FROM requested
         JOIN transfer_orders candidate ON candidate.netsuite_id = requested.numeric_id
        WHERE requested.numeric_id IS NOT NULL
     ),
     to_resolved AS (
       SELECT DISTINCT candidate.requested_ref,
              COALESCE(membership.source_to_id, candidate.candidate_id) AS source_id
         FROM to_candidates candidate
         LEFT JOIN dispatch_scm_to_splits membership
           ON membership.split_to_id = candidate.candidate_id
       UNION
       SELECT requested.requested_ref, membership.source_to_id
         FROM requested
         JOIN dispatch_scm_to_splits membership
           ON upper(BTRIM(membership.source_to_ref)) = requested.requested_ref
       UNION
       SELECT requested.requested_ref, membership.source_to_id
         FROM requested
         JOIN dispatch_scm_to_splits membership
           ON upper(BTRIM(membership.split_to_ref)) = requested.requested_ref
     ),
     closed_orders AS (
       SELECT resolved.requested_ref, 'SO'::text AS kind,
              upper(BTRIM(source.tranid)) AS canonical_ref,
              source.status, source.status_text
         FROM so_resolved resolved
         JOIN sales_orders source ON source.netsuite_id = resolved.source_id
        WHERE ${exactNetSuiteClosedSql("source")}
           OR EXISTS (
             SELECT 1
               FROM dispatch_scm_so_splits family
               JOIN sales_orders child ON child.netsuite_id = family.split_so_id
              WHERE family.source_so_id = source.netsuite_id
                AND ${exactNetSuiteClosedSql("child")}
           )
       UNION ALL
       SELECT resolved.requested_ref, 'PO'::text AS kind,
              upper(BTRIM(source.tranid)) AS canonical_ref,
              source.status, source.status_text
         FROM po_resolved resolved
         JOIN purchase_orders source ON source.netsuite_id = resolved.source_id
        WHERE ${exactNetSuiteClosedSql("source")}
           OR EXISTS (
             SELECT 1
               FROM dispatch_scm_po_splits family
               JOIN purchase_orders child ON child.netsuite_id = family.split_po_id
              WHERE family.source_po_id = source.netsuite_id
                AND ${exactNetSuiteClosedSql("child")}
           )
       UNION ALL
       SELECT resolved.requested_ref, 'TO'::text AS kind,
              upper(BTRIM(source.tranid)) AS canonical_ref,
              source.status, source.status_text
         FROM to_resolved resolved
         JOIN transfer_orders source ON source.netsuite_id = resolved.source_id
        WHERE ${exactNetSuiteClosedSql("source")}
           OR EXISTS (
             SELECT 1
               FROM dispatch_scm_to_splits family
               JOIN transfer_orders child ON child.netsuite_id = family.split_to_id
              WHERE family.source_to_id = source.netsuite_id
                AND ${exactNetSuiteClosedSql("child")}
           )
     )
     SELECT DISTINCT ON (requested_ref, kind, canonical_ref)
            requested_ref, kind, canonical_ref, status, status_text
       FROM closed_orders
      ORDER BY requested_ref, kind, canonical_ref`,
    [refs]
  );
  return result.rows.map((row) => ({
    requestedRef: row.requested_ref,
    kind: row.kind,
    canonicalRef: row.canonical_ref,
    status: row.status || "",
    statusText: row.status_text || ""
  }));
}

export async function assertNoClosedNetSuiteOrders(orderRefs = [], action = "be changed") {
  const conflicts = await listClosedNetSuiteOrders(orderRefs);
  if (conflicts.length) throw new NetSuiteClosedOrderError(conflicts, action);
  return true;
}

export async function scrubClosedNetSuiteOrdersFromOperationalPlan(plan = {}) {
  const conflicts = await listClosedNetSuiteOrders(operationalPlanOrderRefs(plan));
  return scrubOrderRefsFromOperationalPlan(plan, {
    orderRefs: conflicts.map((conflict) => conflict.requestedRef)
  });
}
