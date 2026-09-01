import crypto from "node:crypto";

import { query, withTransaction } from "./db.js";
import {
  compactDispatchOrderCard,
  dispatchOrderSearchText
} from "./dispatch-planner-optimization.js";

const MAX_POOL_LIMIT = 200;
const MAX_SEARCH_LENGTH = 120;

function text(value) {
  return String(value ?? "").trim();
}

function orderRef(order = {}) {
  return text(order.id || order.orderId || order.orderRef || order.tranid || order.refNumber);
}

function orderType(order = {}) {
  return text(order.type || order.orderType || "OTHER").toUpperCase();
}

function safeDate(value) {
  const candidate = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function sortDate(order = {}) {
  return safeDate(order.expectedDeliveryDate || order.deliveryDate || order.shipDate || order.tranDate);
}

function activityAt(order = {}) {
  const parsed = new Date(
    order.updatedAt
    || order.updated_at
    || order.syncedAt
    || order.synced_at
    || order.scm?.updatedAt
    || ""
  );
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString();
}

function catalogRows(orders = [], source = "") {
  const rows = [];
  const seen = new Set();
  for (const order of orders || []) {
    const ref = orderRef(order);
    const key = ref.toLowerCase();
    if (!ref || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      order_ref: ref,
      order_type: orderType(order),
      eligible: order.eligible !== false,
      sort_date: sortDate(order),
      sort_key: `${sortDate(order) || "9999-12-31"}|${ref.toLowerCase()}`,
      search_text: dispatchOrderSearchText(order),
      card: compactDispatchOrderCard(order),
      full_order: { ...order, catalogHydrated: true },
      source: text(source),
      source_updated_at: activityAt(order),
      activity_at: activityAt(order)
    });
  }
  return rows;
}

async function upsertRows(rows = []) {
  if (!rows.length) return { upserted: 0 };
  const result = await query(
    `INSERT INTO dispatch_order_catalog_entries (
       order_ref, order_type, eligible, sort_date, sort_key, search_text,
       card, full_order, source, source_updated_at, activity_at
     )
     SELECT source.order_ref, source.order_type, source.eligible, source.sort_date,
            source.sort_key, source.search_text, source.card, source.full_order,
            source.source, source.source_updated_at, source.activity_at
       FROM jsonb_to_recordset($1::jsonb) AS source(
         order_ref text, order_type text, eligible boolean, sort_date date,
         sort_key text, search_text text, card jsonb, full_order jsonb,
         source text, source_updated_at timestamptz, activity_at timestamptz
       )
     ON CONFLICT (lower(order_ref)) DO UPDATE
       SET order_ref = EXCLUDED.order_ref,
           order_type = EXCLUDED.order_type,
           eligible = EXCLUDED.eligible,
           sort_date = EXCLUDED.sort_date,
           sort_key = EXCLUDED.sort_key,
           search_text = EXCLUDED.search_text,
           card = EXCLUDED.card,
           full_order = EXCLUDED.full_order,
           source = EXCLUDED.source,
           source_updated_at = EXCLUDED.source_updated_at,
           activity_at = EXCLUDED.activity_at,
           catalog_revision = dispatch_order_catalog_entries.catalog_revision + 1,
           updated_at = now()
     RETURNING order_ref`,
    [JSON.stringify(rows)]
  );
  await query(
    `UPDATE dispatch_order_catalog_state
        SET generation = generation + 1,
            catalog_count = (SELECT count(*)::int FROM dispatch_order_catalog_entries),
            updated_at = now()
      WHERE singleton = true`
  );
  return { upserted: result.rowCount, orderRefs: result.rows.map((row) => text(row.order_ref)) };
}

export async function upsertDispatchOrderCatalog({ orders = [], source = "" } = {}) {
  return withTransaction(() => upsertRows(catalogRows(orders, source)));
}

export async function replaceDispatchOrderCatalog({ orders = [], source = "", type = "" } = {}) {
  const requestedType = text(type).toUpperCase();
  const rows = catalogRows(orders, source)
    .filter((row) => !requestedType || row.order_type === requestedType);
  return withTransaction(async () => {
    const upserted = await upsertRows(rows);
    const refs = rows.map((row) => row.order_ref.toLowerCase());
    const deleted = requestedType
      ? await query(
          `DELETE FROM dispatch_order_catalog_entries
            WHERE order_type = $1
              AND NOT (lower(order_ref) = ANY($2::text[]))
          RETURNING order_ref`,
          [requestedType, refs]
        )
      : await query(
          `DELETE FROM dispatch_order_catalog_entries
            WHERE NOT (lower(order_ref) = ANY($1::text[]))
          RETURNING order_ref`,
          [refs]
        );
    await query(
      `UPDATE dispatch_order_catalog_state
          SET generation = generation + 1,
              source = $1,
              catalog_count = (SELECT count(*)::int FROM dispatch_order_catalog_entries),
              legacy_count = $2,
              shadow_match_count = 0,
              shadow_mismatch_count = 0,
              last_shadow_comparison_at = NULL,
              last_full_refresh_at = now(),
              last_error = '',
              updated_at = now()
        WHERE singleton = true`,
      [text(source), rows.length]
    );
    return {
      ...upserted,
      deleted: deleted.rowCount,
      deletedOrderRefs: deleted.rows.map((row) => text(row.order_ref))
    };
  });
}

export async function getDispatchOrderCatalogOrder(ref) {
  const cleanRef = text(ref);
  if (!cleanRef) return null;
  const result = await query(
    `SELECT candidate.full_order
       FROM (
         SELECT global_group.full_order, 0 AS priority
           FROM dispatch_global_order_groups global_group
         WHERE global_group.active = true
            AND lower(global_group.group_ref) = lower($1)
         UNION ALL
         SELECT global_split.full_order, 1 AS priority
           FROM dispatch_global_order_splits global_split
          WHERE global_split.active = true
            AND lower(global_split.split_ref) = lower($1)
         UNION ALL
         SELECT catalog.full_order, 2 AS priority
           FROM dispatch_order_catalog_entries catalog
          WHERE lower(catalog.order_ref) = lower($1)
            AND NOT EXISTS (
              SELECT 1
                FROM dispatch_global_order_splits retired_split
               WHERE retired_split.active = false
                 AND lower(retired_split.split_ref) = lower(catalog.order_ref)
            )
       ) candidate
      ORDER BY candidate.priority
      LIMIT 1`,
    [cleanRef]
  );
  return result.rows[0]?.full_order || null;
}

export async function removeDispatchOrderCatalogOrder(ref) {
  const cleanRef = text(ref);
  if (!cleanRef) return { deleted: false };
  const result = await query(
    `DELETE FROM dispatch_order_catalog_entries
      WHERE lower(order_ref) = lower($1)
      RETURNING order_ref`,
    [cleanRef]
  );
  if (result.rowCount) await query(
    `UPDATE dispatch_order_catalog_state
        SET generation = generation + 1,
            catalog_count = (SELECT count(*)::int FROM dispatch_order_catalog_entries),
            updated_at = now()
      WHERE singleton = true`
  );
  return { deleted: Boolean(result.rowCount), orderRef: result.rows[0]?.order_ref || cleanRef };
}

function cursorError() {
  return Object.assign(new Error("The Dispatch order-pool cursor is invalid."), {
    status: 400,
    code: "DISPATCH_ORDER_POOL_CURSOR_INVALID"
  });
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text(value), "base64url").toString("utf8"));
    if (
      !parsed
      || ![0, 1].includes(Number(parsed.e))
      || typeof parsed.d !== "string"
      || !Number.isFinite(Date.parse(parsed.d))
      || typeof parsed.k !== "string"
      || typeof parsed.r !== "string"
      || parsed.k.length > 500
      || parsed.r.length > 500
    ) throw cursorError();
    return { e: Number(parsed.e), d: parsed.d, k: parsed.k, r: parsed.r };
  } catch (error) {
    if (error?.code === "DISPATCH_ORDER_POOL_CURSOR_INVALID") throw error;
    throw cursorError();
  }
}

function assignmentFields(row = {}) {
  const details = row.assignment && typeof row.assignment === "object" ? row.assignment : {};
  const planned = Boolean(row.plan_id);
  return {
    dispatchPlanned: planned,
    readOnly: planned,
    dispatchPlanId: planned ? text(row.plan_id) : "",
    dispatchPlanDate: planned ? text(row.plan_date).slice(0, 10) : "",
    dispatchTruckPlate: text(details.dispatchTruckPlate),
    dispatchLoadName: text(details.dispatchLoadName),
    dispatchParkingSpot: text(details.dispatchParkingSpot),
    dispatchDriverLogin: text(details.dispatchDriverLogin),
    dispatchDriverName: text(details.dispatchDriverName),
    plannedOrderRef: text(row.planned_order_ref),
    jump: planned ? { planId: text(row.plan_id), planDate: text(row.plan_date).slice(0, 10) } : null
  };
}

export async function listDispatchOrderPool({
  type = "",
  search = "",
  cursor = "",
  limit = 200
} = {}) {
  const requestedType = text(type).toUpperCase();
  const searchTerm = text(search).slice(0, MAX_SEARCH_LENGTH).toLowerCase();
  const decoded = decodeCursor(cursor);
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), MAX_POOL_LIMIT);
  const result = await query(
    `WITH pool_catalog AS (
       SELECT catalog.order_ref, catalog.order_type, catalog.eligible,
              catalog.search_text, catalog.card, catalog.activity_at
         FROM dispatch_order_catalog_entries catalog
        WHERE NOT EXISTS (
          SELECT 1
            FROM dispatch_global_order_groups global_group
           WHERE global_group.active = true
             AND lower(global_group.group_ref) = lower(catalog.order_ref)
        )
          AND NOT EXISTS (
            SELECT 1
              FROM dispatch_global_order_splits global_split
             WHERE global_split.active = true
               AND lower(global_split.split_ref) = lower(catalog.order_ref)
          )
          AND NOT EXISTS (
            SELECT 1
              FROM dispatch_global_order_splits retired_split
             WHERE retired_split.active = false
               AND lower(retired_split.split_ref) = lower(catalog.order_ref)
          )
       UNION ALL
       SELECT global_split.split_ref, global_split.order_type,
              global_split.eligible, global_split.search_text,
              global_split.card, global_split.updated_at
         FROM dispatch_global_order_splits global_split
        WHERE global_split.active = true
          AND NOT EXISTS (
            SELECT 1
              FROM dispatch_global_order_groups global_group
             WHERE global_group.active = true
               AND lower(global_group.group_ref) = lower(global_split.split_ref)
          )
       UNION ALL
       SELECT global_group.group_ref, global_group.order_type,
              global_group.eligible, global_group.search_text,
              global_group.card, global_group.updated_at
         FROM dispatch_global_order_groups global_group
        WHERE global_group.active = true
          AND EXISTS (
            SELECT 1
              FROM dispatch_global_order_group_members member
             WHERE member.group_ref = global_group.group_ref
          )
          AND NOT EXISTS (
            SELECT 1
              FROM dispatch_global_order_group_members member
             WHERE member.group_ref = global_group.group_ref
               AND NOT (
                 EXISTS (
                   SELECT 1
                     FROM dispatch_order_catalog_entries member_catalog
                    WHERE lower(member_catalog.order_ref) = lower(member.member_order_ref)
                      AND member_catalog.eligible = true
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM dispatch_global_order_splits member_split
                    WHERE member_split.active = true
                      AND member_split.eligible = true
                      AND lower(member_split.split_ref) = lower(member.member_order_ref)
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM dispatch_global_order_groups member_group
                    WHERE member_group.active = true
                      AND member_group.eligible = true
                      AND lower(member_group.group_ref) = lower(member.member_order_ref)
                 )
               )
          )
     ), visible_catalog AS (
       SELECT candidate.*
         FROM pool_catalog candidate
        WHERE NOT EXISTS (
          SELECT 1
            FROM dispatch_global_order_group_members member
            JOIN dispatch_global_order_groups global_group
              ON global_group.group_ref = member.group_ref
             AND global_group.active = true
           WHERE lower(member.member_order_ref) = lower(candidate.order_ref)
             AND member.hides_member = true
        )
          AND NOT EXISTS (
            SELECT 1
              FROM dispatch_global_order_splits global_split
             WHERE global_split.active = true
               AND global_split.definition_kind = 'split'
               AND lower(global_split.parent_order_ref) = lower(candidate.order_ref)
          )
     )
     SELECT catalog.order_ref, catalog.card, catalog.activity_at,
            CASE WHEN $2 <> '' AND lower(catalog.order_ref) = $2 THEN 1 ELSE 0 END AS exact_rank,
            assignment.plan_id::text AS plan_id,
            assignment.plan_date::text AS plan_date,
            assignment.planned_order_ref,
            assignment.assignment
       FROM visible_catalog catalog
       LEFT JOIN LATERAL (
         SELECT candidate.plan_id, candidate.plan_date, candidate.planned_order_ref,
                candidate.assignment
           FROM dispatch_plan_order_assignments candidate
           JOIN dispatch_plans plan ON plan.id = candidate.plan_id
          WHERE lower(candidate.order_ref) = lower(catalog.order_ref)
            AND plan.status <> 'cancelled'
          ORDER BY candidate.plan_date DESC, candidate.plan_id DESC
          LIMIT 1
       ) assignment ON true
      WHERE catalog.eligible = true
        AND ($1 = '' OR catalog.order_type = $1 OR ($1 = 'TO' AND catalog.order_type = 'CUSTOM'))
        AND (
          $2 = ''
          OR lower(catalog.order_ref) = $2
          OR catalog.search_text ILIKE ('%' || $2 || '%')
        )
        AND ($2 <> '' OR assignment.plan_id IS NULL)
        AND (
          $3::int IS NULL
          OR CASE WHEN $2 <> '' AND lower(catalog.order_ref) = $2 THEN 1 ELSE 0 END < $3
          OR (
            CASE WHEN $2 <> '' AND lower(catalog.order_ref) = $2 THEN 1 ELSE 0 END = $3
            AND (catalog.activity_at, lower(catalog.order_ref)) < ($4::timestamptz, $5)
          )
        )
      ORDER BY exact_rank DESC,
               catalog.activity_at DESC,
               lower(catalog.order_ref) DESC
      LIMIT $6`,
    [
      requestedType,
      searchTerm,
      decoded?.e ?? null,
      decoded?.d || new Date(0).toISOString(),
      decoded?.r || "",
      safeLimit + 1
    ]
  );
  const hasMore = result.rows.length > safeLimit;
  const page = result.rows.slice(0, safeLimit);
  const last = page.at(-1);
  const state = await getDispatchOrderCatalogState();
  return {
    orders: page.map((row) => ({ ...row.card, ...assignmentFields(row) })),
    nextCursor: hasMore && last ? encodeCursor({
      e: Number(last.exact_rank || 0),
      d: new Date(last.activity_at).toISOString(),
      k: text(last.order_ref).toLowerCase(),
      r: text(last.order_ref).toLowerCase()
    }) : "",
    ready: state.ready,
    source: "catalog",
    catalogRevision: state.generation
  };
}

export async function getDispatchOrderCatalogState() {
  const result = await query(
    `SELECT state.status, state.generation, state.source, state.catalog_count,
            state.legacy_count, state.assignments_ready,
            state.shadow_match_count, state.shadow_mismatch_count,
            state.last_shadow_comparison_at,
            state.last_full_refresh_at, state.last_error, state.updated_at,
            (SELECT count(*)::int
               FROM dispatch_order_catalog_refresh_outbox refresh
              WHERE refresh.status IN ('pending', 'failed', 'running')) AS pending_refresh_count
       FROM dispatch_order_catalog_state state
      WHERE state.singleton = true`
  );
  const row = result.rows[0] || {};
  return {
    status: row.status || "warming",
    ready: row.status === "ready",
    generation: Number(row.generation || 0),
    source: row.source || "",
    catalogCount: Number(row.catalog_count || 0),
    legacyCount: Number(row.legacy_count || 0),
    assignmentsReady: row.assignments_ready === true,
    shadowMatchCount: Number(row.shadow_match_count || 0),
    shadowMismatchCount: Number(row.shadow_mismatch_count || 0),
    pendingRefreshCount: Number(row.pending_refresh_count || 0),
    lastShadowComparisonAt: row.last_shadow_comparison_at || null,
    lastFullRefreshAt: row.last_full_refresh_at || null,
    lastError: row.last_error || "",
    updatedAt: row.updated_at || null
  };
}

export async function markDispatchOrderCatalogReady({ source = "", assignmentsReady = true } = {}) {
  const result = await query(
    `UPDATE dispatch_order_catalog_state
        SET status = 'ready',
            source = $1,
            assignments_ready = $2,
            catalog_count = (SELECT count(*)::int FROM dispatch_order_catalog_entries),
            last_error = '',
            updated_at = now()
      WHERE singleton = true
      RETURNING generation`,
    [text(source), assignmentsReady === true]
  );
  return { ready: true, generation: Number(result.rows[0]?.generation || 0) };
}

export async function markDispatchOrderCatalogFailed(error) {
  await query(
    `UPDATE dispatch_order_catalog_state
        SET status = 'failed', last_error = left($1, 2000), updated_at = now()
      WHERE singleton = true`,
    [text(error?.message || error)]
  );
}

function refreshKey({ orderRef: ref = "", orderType: type = "" } = {}) {
  const cleanRef = text(ref).toLowerCase();
  const cleanType = text(type).toUpperCase();
  return cleanRef ? `order:${cleanType}:${cleanRef}` : `full:${cleanType || "all"}`;
}

export async function enqueueDispatchOrderCatalogRefresh({ orderRef: ref = "", orderType: type = "", source = "" } = {}) {
  const cleanRef = text(ref);
  const cleanType = text(type).toUpperCase();
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", ["dispatch-order-catalog-refresh"]);
    const result = await query(
      `INSERT INTO dispatch_order_catalog_refresh_outbox (
         refresh_key, order_ref, order_type, source, status, available_at
       ) VALUES ($1, $2, $3, $4, 'pending', now())
       ON CONFLICT (refresh_key) DO UPDATE
         SET order_type = CASE
               WHEN dispatch_order_catalog_refresh_outbox.order_type = '' THEN EXCLUDED.order_type
               ELSE dispatch_order_catalog_refresh_outbox.order_type
             END,
             source = EXCLUDED.source,
             status = 'pending',
             available_at = now(),
             completed_at = NULL,
             last_error = '',
             updated_at = now()
       RETURNING id::text, order_ref, order_type, status`,
      [refreshKey({ orderRef: cleanRef, orderType: cleanType }), cleanRef, cleanType, text(source)]
    );
    const row = result.rows[0];
    if (!cleanRef) {
      await query(
        `UPDATE dispatch_order_catalog_refresh_outbox
            SET status = 'complete', completed_at = now(), last_error = '', updated_at = now()
          WHERE id <> $1
            AND order_ref <> ''
            AND status IN ('pending', 'failed')
            AND ($2 = '' OR order_type = $2)`,
        [row.id, cleanType]
      );
    }
    return { id: row.id, orderRef: row.order_ref, orderType: row.order_type, status: row.status };
  });
}

export async function claimDispatchOrderCatalogRefreshes({ limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const result = await query(
    `WITH candidates AS (
       SELECT refresh.id
         FROM dispatch_order_catalog_refresh_outbox refresh
        WHERE (
          (refresh.status IN ('pending', 'failed') AND refresh.available_at <= now())
          OR (refresh.status = 'running' AND refresh.claimed_at < now() - interval '10 minutes')
        )
        ORDER BY refresh.id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE dispatch_order_catalog_refresh_outbox refresh
        SET status = 'running',
            attempts = attempts + 1,
            claimed_at = now(),
            updated_at = now()
       FROM candidates
      WHERE refresh.id = candidates.id
      RETURNING refresh.id::text, refresh.order_ref, refresh.order_type,
                refresh.source, refresh.attempts`,
    [safeLimit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    orderRef: row.order_ref,
    orderType: row.order_type,
    source: row.source,
    attempts: Number(row.attempts || 0)
  }));
}

export async function completeDispatchOrderCatalogRefresh(id) {
  const result = await query(
    `UPDATE dispatch_order_catalog_refresh_outbox
        SET status = 'complete', completed_at = now(), last_error = '', updated_at = now()
      WHERE id = $1
        AND status = 'running'
      RETURNING id::text`,
    [id]
  );
  return Boolean(result.rows[0]);
}

export async function failDispatchOrderCatalogRefresh(id, error) {
  const result = await query(
    `UPDATE dispatch_order_catalog_refresh_outbox
        SET status = 'failed',
            last_error = left($2, 2000),
            available_at = now() + make_interval(secs => LEAST(300, GREATEST(2, attempts * attempts * 2))),
            updated_at = now()
      WHERE id = $1
        AND status = 'running'
      RETURNING id::text`,
    [id, text(error?.message || error)]
  );
  return Boolean(result.rows[0]);
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function recordDispatchOrderPoolShadowComparison({ requestKey = "", legacy = [], optimized = [] } = {}) {
  const refs = (orders) => (orders || []).map((order) => text(order?.id || order?.orderRef)).filter(Boolean).sort();
  const legacyRefs = refs(legacy);
  const optimizedRefs = refs(optimized);
  const legacyDigest = digest(legacyRefs);
  const optimizedDigest = digest(optimizedRefs);
  const matches = legacyDigest === optimizedDigest;
  await withTransaction(async () => {
    await query(
      `UPDATE dispatch_order_catalog_state
          SET shadow_match_count = shadow_match_count + CASE WHEN $1 THEN 1 ELSE 0 END,
              shadow_mismatch_count = shadow_mismatch_count + CASE WHEN $1 THEN 0 ELSE 1 END,
              last_shadow_comparison_at = now(),
              updated_at = now()
        WHERE singleton = true`,
      [matches]
    );
    if (!matches) {
      await query(
        `INSERT INTO dispatch_planner_shadow_mismatches (
           comparison_kind, request_key, legacy_digest, optimized_digest, details
         ) VALUES ('order_pool', $1, $2, $3, $4::jsonb)`,
        [text(requestKey).slice(0, 500), legacyDigest, optimizedDigest, JSON.stringify({
          legacyOnly: legacyRefs.filter((ref) => !optimizedRefs.includes(ref)).slice(0, 100),
          optimizedOnly: optimizedRefs.filter((ref) => !legacyRefs.includes(ref)).slice(0, 100),
          legacyCount: legacyRefs.length,
          optimizedCount: optimizedRefs.length
        })]
      );
    }
  });
  return { matches, legacyDigest, optimizedDigest };
}
