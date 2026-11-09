// @ts-check
// Admin -> Performance: NetSuite posting time for IF, IR and CM, and server-side load time of the
// pages and API calls (src/request-timing.js), grouped by app area.
//
// Posting sources:
//  - Operator IF/IR (customer pickup, delivery loads, receiving, transfer and direct PO receipts):
//    operator_netsuite_posting_attempts (NetSuite time = finished - started of the posted attempt)
//    and steps/commands (total = step posted_at - command created_at, i.e. submit -> confirmed).
//  - SO auto-fulfillment IF: dispatch_sales_order_if_candidates (created -> completed); the NetSuite
//    call itself from system_audit_events (RESTlet post without a command id), recorded since 2026-11-05.
//  - Return credit memos: delivery_audit_log returns.netsuite.batch_cm.linked details.timingsMs
//    (createMs = NetSuite create, totalMs = lookup + create + read-back), recorded since 2026-11-05.
//  - Purchase orders created / changed by the app: system_audit_events netsuite.purchaseorder.created /
//    .updated (duration_ms per NetSuite call, summed per MBBS request), classified by the MBBS route that
//    made the write (details.requestPath); total = that route's server time from system_request_timings;
//    failures = delivery_audit_log netsuite.attempt.failed on purchaseOrder record paths. Since 2026-11-05.
// Driver completion: online completions from the driver-completion trace (delivery_audit_log
// driver.job.*), offline completions from driver_offline_events (device tap -> received -> applied),
// photo upload failures (driver-pwa-upload) and offline photo verification failures.
// "Needs attention now" counts what is waiting for someone today, whatever the range.
import { getDriverOfflineReviewCounts, listDriverClientSyncIssues } from './driver-offline-repository.js';
import { query } from './db.js';
import { listRequestTimings, timingPercentile } from './request-timing.js';

const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 31 * DAY_MS;
// Day slots start at Toronto midnight (EST); hourly slots for ranges up to 2 days.
const SLOT_ORIGIN = "TIMESTAMPTZ '2000-01-01 05:00:00+00'";

const POSTING_LABELS = Object.freeze({
  'IF|customer_pickup_load|SO': ['Customer pickup', 'Operator PWA'],
  'IF|delivery_prep_load|SO': ['Delivery load', 'Operator PWA'],
  'IF|delivery_prep_load|TO': ['Delivery load (transfer order)', 'Operator PWA'],
  'IF|delivery_consolidation_load|SO': ['Delivery consolidation', 'Operator PWA'],
  'IF|delivery_consolidation_load|TO': ['Delivery consolidation (transfer order)', 'Operator PWA'],
  'IF|transfer_background_posting|TO': ['Transfer order shipment', 'Background'],
  'IR|receiving_receipt|PO': ['Receiving', 'Operator PWA'],
  'IR|receiving_receipt|TO': ['Receiving (transfer order)', 'Operator PWA'],
  'IR|direct_po_receipt|PO': ['Direct PO receipt', 'Background'],
  'IR|transfer_background_posting|TO': ['Transfer order receipt', 'Background'],
  'IF|so_auto_fulfillment|SO': ['SO auto-fulfillment', 'Dispatch (automatic)'],
  'CM|return_credit_memo|RA': ['Return credit memo', 'Returns']
});

/** Matches a real request path against an Express route template ("/a/:id/b"). @param {string} route */
function routePattern(route) {
  const parts = route.split('/').map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^$()|[\]\\]/gu, '\\$&')));
  return new RegExp(`^${parts.join('/')}$`, 'u');
}

// Purchase-order writes, by the MBBS route that made them. `routes` are the Express route templates
// (as timed in system_request_timings); details.requestPath holds the real path, matched by pattern.
export const PO_FLOWS = Object.freeze([
  { key: 'special_create', label: 'Special Item PO create', source: 'Special Items (SCM)', link: '/scm/stock-requests',
    routes: [['POST', '/api/scm/special-stock-requests/:id/purchase-order/create']] },
  { key: 'smart_create', label: 'Smart SCM PO create', source: 'Smart SCM', link: '/scm/smart',
    routes: [['POST', '/api/scm/smart/vendor-workflows/:id/create-purchase-order'], ['POST', '/api/scm/smart/netsuite-purchase-orders/:id/insert']] },
  { key: 'po_edit', label: 'PO edit', source: 'SCM NetSuite PO', link: '/scm/netsuite-po',
    routes: [['PATCH', '/api/scm/netsuite-po-history/:id']] },
  { key: 'special_items', label: 'Special PO items added', source: 'Special Items (SCM)', link: '/scm/stock-requests',
    routes: [['POST', '/api/scm/special-stock-requests/:id/purchase-order/items'],
      ['POST', '/api/scm/special-stock-requests/:id/purchase-order/items/:lineId/retry']] },
  { key: 'special_quantity', label: 'Special quantity review', source: 'Special Items (SCM)', link: '/scm/stock-requests',
    routes: [['POST', '/api/scm/special-stock-requests/:id/quantity-review']] },
  { key: 'special_closure', label: 'Special closure', source: 'Special Items (SCM)', link: '/scm/stock-requests',
    routes: [['POST', '/api/scm/special-stock-requests/:id/closure-review']] },
  { key: 'po_note', label: 'PO note / routing', source: 'Special Items / Backorder (SCM)', link: '/scm/stock-requests',
    routes: [['PUT', '/api/scm/special-stock-requests/:id/purchase-order/routing'], ['PUT', '/api/scm/stock-requests/:id/backorder/purchase-order/routing']] }
].map((flow) => ({ ...flow, patterns: flow.routes.map(([, route]) => routePattern(route)) })));
const OTHER_PO_FLOW = Object.freeze({ key: 'other', label: 'Other PO change', source: '', link: null, routes: [], patterns: [] });
const POSTING_ORDER = [...Object.keys(POSTING_LABELS).filter((key) => !key.startsWith('CM|')),
  ...[...PO_FLOWS, OTHER_PO_FLOW].map((flow) => `PO|${flow.key}|PO`), 'CM|return_credit_memo|RA'];

// Pages are attributed by the calling page (Referer); calls without one fall back to the route.
export const PAGE_GROUPS = Object.freeze([
  { key: 'special', label: 'Special Items', pages: ['/sales/stock-requests', '/scm/stock-requests', '/dispatch/special-stock'],
    route: /special-stock/u },
  { key: 'planning', label: 'Dispatch planning', pages: ['/dispatch/planning', '/sales/planning', '/dispatch'],
    route: /^\/api\/dispatch\/(?:v2\/|plans|plan-edit-lease|config|setup|vendor-yards|forecast|driver-job-statuses|orders\/|sync)/u },
  { key: 'monitor', label: 'Dispatch monitor', pages: ['/dispatch/monitor', '/sales/monitor'],
    route: /^\/api\/dispatch\/(?:monitor|maps\/monitor-eta)/u },
  { key: 'operator', label: 'Operator PWA', pages: ['/operator', '/operator.html'],
    route: /^\/api\/(?:delivery|customer-pickup|receiving|returns|inventory|count-sheets|operator)\//u },
  { key: 'driver', label: 'Driver PWA', pages: ['/driver', '/driver.html', '/driver-service-worker.js'],
    route: /^\/api\/driver\//u }
]);

export const KEY_ENDPOINTS = Object.freeze([
  ['POST', '/api/customer-pickup/lookup', 'Order lookup (customer pickup scan)'],
  ['POST', '/api/returns/orders/lookup', 'Order lookup (returns)'],
  ['GET', '/api/customer-pickup/orders/:id', 'Pickup order detail'],
  ['GET', '/api/delivery/orders/:id', 'Delivery order detail'],
  ['GET', '/api/delivery/bootstrap', 'Delivery order list'],
  ['GET', '/api/receiving/orders', 'Receiving order list'],
  ['GET', '/api/receiving/orders/:id', 'Receiving order detail'],
  ['POST', '/api/driver/photo-upload-token', 'Photo upload ticket'],
  ['POST', '/api/driver/jobs/:jobId/photos', 'Photo save after upload'],
  ['POST', '/api/driver/offline-sync', 'Offline photo / job sync'],
  ['GET', '/api/driver/next-job', 'Next job'],
  ['GET', '/api/sales/special-stock-requests', 'Special request list (Sales)'],
  ['GET', '/api/sales/special-stock-requests/:id', 'Special request detail (Sales)'],
  ['GET', '/api/scm/special-stock-requests', 'Special request list (SCM)'],
  ['GET', '/api/scm/special-stock-requests/:id', 'Special request detail (SCM)'],
  ['GET', '/api/dispatch/special-stock-handoffs', 'Special stock handoffs (Dispatch)'],
  ['GET', '/api/dispatch/v2/bootstrap', 'Planning board load'],
  ['GET', '/api/dispatch/v2/order-pool', 'Order pool (one page)'],
  ['GET', '/api/dispatch/monitor', 'Monitor refresh']
]);
// Automatic refreshes: shown after the calls people wait for.
const BACKGROUND_ROUTES = [
  /^\/api\/delivery\/notifications$/u, /^\/api\/dispatch\/plans\/:id\/revision$/u, /^\/api\/dispatch\/plan-edit-lease(?:\/heartbeat)?$/u,
  /\/alerts$/u, /^\/api\/driver\/(?:network-health|client-version|route-presence)$/u
];

/** Resolves a preset ("today", "24h", "7d", "30d") or an explicit from/to into a bounded range.
 * @param {{range?: string, from?: string, to?: string}} input @param {number} [now] */
export function performanceRange({ range = '7d', from = '', to = '' } = {}, now = Date.now()) {
  const parsedTo = Date.parse(String(to || ''));
  const parsedFrom = Date.parse(String(from || ''));
  let toMs = Number.isFinite(parsedTo) ? Math.min(parsedTo, now) : now;
  let fromMs;
  if (Number.isFinite(parsedFrom)) fromMs = parsedFrom;
  else if (range === 'today') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(toMs)).map((part) => [part.type, part.value]));
    const sinceMidnight = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
    fromMs = Math.floor(toMs / 1000) * 1000 - sinceMidnight;
  } else {
    fromMs = toMs - ({ '24h': 1, '30d': 30 }[range] ?? 7) * DAY_MS;
  }
  if (!(fromMs < toMs)) fromMs = toMs - 7 * DAY_MS;
  if (toMs - fromMs > MAX_RANGE_MS) fromMs = toMs - MAX_RANGE_MS;
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), slotSeconds: toMs - fromMs <= 2 * DAY_MS ? 3600 : 86_400 };
}

const ms = (value) => (value === null || value === undefined ? null : Math.round(Number(value)));

/** @param {{from: string, to: string, slotSeconds: number}} range */
export async function listPostingPerformance({ from, to, slotSeconds }) {
  const params = [from, to, slotSeconds];
  const [operator, operatorTrend, auto, autoTrend, autoNetSuite, cm, cmTrend, cmFailed, slowest, failures] = await Promise.all([
    query(
      `WITH timed AS (
         SELECT s.transaction_type AS tt, COALESCE(c.input_snapshot->'localOperation'->>'kind', c.function_key) AS kind,
                s.source_order_kind AS order_kind, a.outcome,
                EXTRACT(EPOCH FROM (a.finished_at - a.started_at)) * 1000 AS ns_ms,
                CASE WHEN a.outcome = 'posted' AND s.posted_at IS NOT NULL
                     THEN EXTRACT(EPOCH FROM (s.posted_at - c.created_at)) * 1000 END AS total_ms
           FROM operator_netsuite_posting_attempts a
           JOIN operator_netsuite_posting_steps s ON s.id = a.step_id
           JOIN operator_netsuite_posting_commands c ON c.id = s.command_id
          WHERE a.started_at >= $1::timestamptz AND a.started_at < $2::timestamptz AND a.finished_at IS NOT NULL
       )
       SELECT tt, kind, order_kind,
              count(*) FILTER (WHERE outcome IN ('posted', 'recovered'))::int AS posted,
              count(*) FILTER (WHERE outcome IN ('failed', 'uncertain'))::int AS failed,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ns_ms) FILTER (WHERE outcome = 'posted') AS ns_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY ns_ms) FILTER (WHERE outcome = 'posted') AS ns_p90,
              max(ns_ms) FILTER (WHERE outcome = 'posted') AS ns_max,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS total_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY total_ms) AS total_p90,
              max(total_ms) AS total_max
         FROM timed GROUP BY 1, 2, 3`, params.slice(0, 2)),
    query(
      `SELECT s.transaction_type AS tt, COALESCE(c.input_snapshot->'localOperation'->>'kind', c.function_key) AS kind,
              s.source_order_kind AS order_kind,
              date_bin(make_interval(secs => $3::int), s.posted_at, ${SLOT_ORIGIN}) AS slot_at, count(*)::int AS count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.posted_at - c.created_at)) * 1000) AS p50
         FROM operator_netsuite_posting_steps s
         JOIN operator_netsuite_posting_commands c ON c.id = s.command_id
        WHERE s.posted_at >= $1::timestamptz AND s.posted_at < $2::timestamptz
        GROUP BY 1, 2, 3, 4 ORDER BY 4`, params),
    query(
      `SELECT count(*) FILTER (WHERE status = 'completed')::int AS posted,
              count(*) FILTER (WHERE status = 'completed' AND attempt_count > 1)::int AS retried,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS total_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS total_p90,
              max(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS total_max,
              (SELECT count(*)::int FROM dispatch_sales_order_if_candidates
                WHERE status = 'attention' AND updated_at >= $1::timestamptz AND updated_at < $2::timestamptz) AS failed
         FROM dispatch_sales_order_if_candidates
        WHERE status = 'completed' AND completed_at >= $1::timestamptz AND completed_at < $2::timestamptz`, params.slice(0, 2)),
    query(
      `SELECT date_bin(make_interval(secs => $3::int), completed_at, ${SLOT_ORIGIN}) AS slot_at, count(*)::int AS count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS p50
         FROM dispatch_sales_order_if_candidates
        WHERE status = 'completed' AND completed_at >= $1::timestamptz AND completed_at < $2::timestamptz
        GROUP BY 1 ORDER BY 1`, params),
    query(
      `SELECT count(*)::int AS calls,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS ns_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS ns_p90,
              max(duration_ms) AS ns_max
         FROM system_audit_events
        WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
          AND category = 'netsuite' AND action = 'netsuite.restlet.called'
          AND details->'payload'->>'action' = 'post' AND COALESCE(details->>'commandId', '') = ''`, params.slice(0, 2)),
    query(
      `WITH linked AS (
         SELECT DISTINCT ON (details->>'batchId') created_at,
                (details->'timingsMs'->>'createMs')::numeric AS create_ms, (details->'timingsMs'->>'totalMs')::numeric AS total_ms
           FROM delivery_audit_log
          WHERE action = 'returns.netsuite.batch_cm.linked' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
            AND details->'timingsMs' ? 'createMs'
          ORDER BY details->>'batchId', created_at
       )
       SELECT count(*)::int AS posted,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY create_ms) AS ns_p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY create_ms) AS ns_p90,
              max(create_ms) AS ns_max, percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS total_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY total_ms) AS total_p90, max(total_ms) AS total_max
         FROM linked`, params.slice(0, 2)),
    query(
      `WITH linked AS (
         SELECT DISTINCT ON (details->>'batchId') created_at, (details->'timingsMs'->>'totalMs')::numeric AS total_ms
           FROM delivery_audit_log
          WHERE action = 'returns.netsuite.batch_cm.linked' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
            AND details->'timingsMs' ? 'createMs'
          ORDER BY details->>'batchId', created_at
       )
       SELECT date_bin(make_interval(secs => $3::int), created_at, ${SLOT_ORIGIN}) AS slot_at, count(*)::int AS count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50
         FROM linked GROUP BY 1 ORDER BY 1`, params),
    query(
      `SELECT count(*)::int AS failed FROM return_batch_authorizations
        WHERE sync_status = 'failed' AND COALESCE(intent_snapshot->>'transactionType', 'credit_memo') = 'credit_memo'
          AND COALESCE(attempted_at, updated_at) >= $1::timestamptz AND COALESCE(attempted_at, updated_at) < $2::timestamptz`,
      params.slice(0, 2)),
    query(
      `(SELECT 'operator' AS origin, s.transaction_type AS tt,
               COALESCE(c.input_snapshot->'localOperation'->>'kind', c.function_key) AS kind, s.source_order_kind AS order_kind,
               s.posted_at AS at, s.source_order_ref AS order_ref, s.netsuite_transaction_ref AS record_ref,
               COALESCE(o.display_name, o.username) AS actor, s.attempt_count AS attempts,
               EXTRACT(EPOCH FROM (s.posted_at - c.created_at)) * 1000 AS total_ms,
               (SELECT EXTRACT(EPOCH FROM (a.finished_at - a.started_at)) * 1000 FROM operator_netsuite_posting_attempts a
                 WHERE a.step_id = s.id AND a.outcome = 'posted' ORDER BY a.attempt_number DESC LIMIT 1) AS ns_ms
          FROM operator_netsuite_posting_steps s
          JOIN operator_netsuite_posting_commands c ON c.id = s.command_id
          LEFT JOIN operators o ON o.id = c.actor_operator_id
         WHERE s.posted_at >= $1::timestamptz AND s.posted_at < $2::timestamptz
         ORDER BY s.posted_at - c.created_at DESC LIMIT 15)
       UNION ALL
       (SELECT 'auto', 'IF', 'so_auto_fulfillment', 'SO', completed_at, source_sales_order_ref, netsuite_transaction_ref, NULL,
               attempt_count, EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000, NULL
          FROM dispatch_sales_order_if_candidates
         WHERE status = 'completed' AND completed_at >= $1::timestamptz AND completed_at < $2::timestamptz
         ORDER BY completed_at - created_at DESC LIMIT 15)
       UNION ALL
       (SELECT DISTINCT ON (l.details->>'batchId') 'cm', 'CM', 'return_credit_memo', 'RA', l.created_at,
               COALESCE(b.intent_snapshot->>'sourceSalesOrderRef', b.intent_snapshot->>'batchReference'),
               COALESCE(b.netsuite_transaction_ref, l.details->>'transactionRef'),
               COALESCE(o.display_name, o.username, b.intent_snapshot->>'operatorAccount'), b.sync_attempts,
               (l.details->'timingsMs'->>'totalMs')::numeric, (l.details->'timingsMs'->>'createMs')::numeric
          FROM delivery_audit_log l
          LEFT JOIN return_batch_authorizations b ON b.batch_id::text = l.details->>'batchId'
          LEFT JOIN operators o ON o.id = l.actor_operator_id
         WHERE l.action = 'returns.netsuite.batch_cm.linked' AND l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz
           AND l.details->'timingsMs' ? 'createMs'
         ORDER BY l.details->>'batchId', l.created_at)`, params.slice(0, 2)),
    query(
      `(SELECT a.finished_at AS at, s.transaction_type AS tt,
               COALESCE(c.input_snapshot->'localOperation'->>'kind', c.function_key) AS kind, s.source_order_kind AS order_kind,
               s.source_order_ref AS order_ref, a.outcome, LEFT(COALESCE(a.error, ''), 300) AS error,
               EXTRACT(EPOCH FROM (a.finished_at - a.started_at)) * 1000 AS ns_ms
          FROM operator_netsuite_posting_attempts a
          JOIN operator_netsuite_posting_steps s ON s.id = a.step_id
          JOIN operator_netsuite_posting_commands c ON c.id = s.command_id
         WHERE a.started_at >= $1::timestamptz AND a.started_at < $2::timestamptz AND a.outcome IN ('failed', 'uncertain'))
       UNION ALL
       (SELECT COALESCE(attempted_at, updated_at), 'CM', 'return_credit_memo', 'RA',
               COALESCE(intent_snapshot->>'sourceSalesOrderRef', intent_snapshot->>'batchReference'), 'failed',
               LEFT(COALESCE(sync_error, ''), 300), NULL
          FROM return_batch_authorizations
         WHERE sync_status = 'failed' AND COALESCE(attempted_at, updated_at) >= $1::timestamptz
           AND COALESCE(attempted_at, updated_at) < $2::timestamptz)
       ORDER BY 1 DESC LIMIT 12`, params.slice(0, 2))
  ]);

  /** @type {Map<string, Record<string, any>>} */
  const rows = new Map();
  const row = (tt, kind, orderKind) => {
    const key = `${tt}|${kind}|${orderKind}`;
    if (!rows.has(key)) {
      const [label, source] = POSTING_LABELS[key] || [String(kind).replaceAll('_', ' '), ''];
      rows.set(key, { key, type: tt, label, source, posted: 0, failed: 0, retried: null, nsP50Ms: null, nsP90Ms: null,
        nsMaxMs: null, totalP50Ms: null, totalP90Ms: null, totalMaxMs: null, trend: [] });
    }
    return rows.get(key);
  };
  for (const item of operator.rows) {
    Object.assign(row(item.tt, item.kind, item.order_kind), {
      posted: item.posted, failed: item.failed, nsP50Ms: ms(item.ns_p50), nsP90Ms: ms(item.ns_p90), nsMaxMs: ms(item.ns_max),
      totalP50Ms: ms(item.total_p50), totalP90Ms: ms(item.total_p90), totalMaxMs: ms(item.total_max)
    });
  }
  for (const item of operatorTrend.rows) {
    row(item.tt, item.kind, item.order_kind).trend.push({ at: new Date(item.slot_at).toISOString(), count: item.count, p50Ms: ms(item.p50) });
  }
  const autoRow = auto.rows[0];
  const autoNs = autoNetSuite.rows[0];
  if (autoRow.posted || autoRow.failed) {
    Object.assign(row('IF', 'so_auto_fulfillment', 'SO'), {
      posted: autoRow.posted, failed: autoRow.failed, retried: autoRow.retried,
      nsP50Ms: autoNs.calls ? ms(autoNs.ns_p50) : null, nsP90Ms: autoNs.calls ? ms(autoNs.ns_p90) : null,
      nsMaxMs: autoNs.calls ? ms(autoNs.ns_max) : null,
      totalP50Ms: ms(autoRow.total_p50), totalP90Ms: ms(autoRow.total_p90), totalMaxMs: ms(autoRow.total_max),
      trend: autoTrend.rows.map((item) => ({ at: new Date(item.slot_at).toISOString(), count: item.count, p50Ms: ms(item.p50) }))
    });
  }
  const cmRow = cm.rows[0];
  if (cmRow.posted || cmFailed.rows[0].failed) {
    Object.assign(row('CM', 'return_credit_memo', 'RA'), {
      posted: cmRow.posted, failed: cmFailed.rows[0].failed,
      nsP50Ms: ms(cmRow.ns_p50), nsP90Ms: ms(cmRow.ns_p90), nsMaxMs: ms(cmRow.ns_max),
      totalP50Ms: ms(cmRow.total_p50), totalP90Ms: ms(cmRow.total_p90), totalMaxMs: ms(cmRow.total_max),
      trend: cmTrend.rows.map((item) => ({ at: new Date(item.slot_at).toISOString(), count: item.count, p50Ms: ms(item.p50) }))
    });
  }
  const order = (key) => (POSTING_ORDER.includes(key) ? POSTING_ORDER.indexOf(key) : POSTING_ORDER.length);
  const describe = (item) => {
    const [label, source] = POSTING_LABELS[`${item.tt}|${item.kind}|${item.order_kind}`] || [String(item.kind).replaceAll('_', ' '), ''];
    return { type: item.tt, label, source };
  };
  return {
    rows: [...rows.values()].sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label)),
    slowest: slowest.rows
      .filter((item) => item.total_ms !== null)
      .sort((a, b) => Number(b.total_ms) - Number(a.total_ms))
      .slice(0, 15)
      .map((item) => ({ ...describe(item), at: new Date(item.at).toISOString(), orderRef: item.order_ref || null,
        recordRef: item.record_ref || null, actor: item.actor || null, attempts: item.attempts, totalMs: ms(item.total_ms), nsMs: ms(item.ns_ms) })),
    failures: failures.rows.map((item) => ({ ...describe(item), at: new Date(item.at).toISOString(), orderRef: item.order_ref || null,
      outcome: item.outcome, error: item.error || null, nsMs: ms(item.ns_ms) }))
  };
}

/** Groups request timings by app area; key endpoints first, automatic refreshes last.
 * @param {Awaited<ReturnType<typeof listRequestTimings>>} timings */
export function groupRequestTimings(timings) {
  const keyIndex = new Map(KEY_ENDPOINTS.map(([method, route, label], index) => [`${method} ${route}`, { label, index }]));
  const groupFor = (row) => {
    const byPage = PAGE_GROUPS.find((group) => group.pages.includes(row.page));
    if (byPage) return byPage.key;
    if (!row.page) return PAGE_GROUPS.find((group) => group.route.test(row.route))?.key || 'other';
    return 'other';
  };
  /** @type {Map<string, Map<string, Record<string, any>>>} */
  const groups = new Map([...PAGE_GROUPS.map((group) => [group.key, new Map()]), ['other', new Map()]]);
  for (const row of timings.rows) {
    const endpoints = groups.get(groupFor(row));
    const isPage = row.method === 'GET' && row.route === row.page && !row.route.startsWith('/api/');
    const id = `${row.method} ${row.route}`;
    const current = endpoints.get(id) || { method: row.method, route: row.route, isPage, count: 0, errors: 0, rejected: 0,
      totalMs: 0, maxMs: 0, buckets: new Array(timings.edgesMs.length + 1).fill(0) };
    current.count += row.count;
    current.errors += row.errors;
    current.rejected += row.rejected;
    current.totalMs += (row.avgMs || 0) * row.count;
    current.maxMs = Math.max(current.maxMs, row.maxMs || 0);
    row.buckets.forEach((value, index) => { current.buckets[index] += value; });
    endpoints.set(id, current);
  }
  const trend = new Map();
  for (const point of timings.trend) {
    const id = `${point.method} ${point.route}`;
    if (!trend.has(id)) trend.set(id, []);
    trend.get(id).push({ at: point.at, count: point.count, p90Ms: point.p90Ms });
  }
  const labels = Object.fromEntries([...PAGE_GROUPS.map((group) => [group.key, group.label]), ['other', 'Other pages']]);
  return [...groups.entries()].map(([key, endpoints]) => {
    const list = [...endpoints.values()].map((item) => {
      const pinned = keyIndex.get(`${item.method} ${item.route}`);
      return {
        method: item.method, route: item.route, label: pinned?.label || (item.isPage ? 'Page (HTML)' : null),
        key: Boolean(pinned), page: item.isPage, background: BACKGROUND_ROUTES.some((pattern) => pattern.test(item.route)),
        count: item.count, errors: item.errors, rejected: item.rejected,
        avgMs: item.count ? Math.round(item.totalMs / item.count) : null, maxMs: item.maxMs,
        p50Ms: timingPercentile(item.buckets, 0.5, item.maxMs), p90Ms: timingPercentile(item.buckets, 0.9, item.maxMs),
        p95Ms: timingPercentile(item.buckets, 0.95, item.maxMs),
        trend: pinned ? trend.get(`${item.method} ${item.route}`) || [] : [], keyOrder: pinned?.index ?? Number.MAX_SAFE_INTEGER
      };
    }).sort((a, b) => Number(a.background) - Number(b.background) || Number(b.page) - Number(a.page)
      || a.keyOrder - b.keyOrder || b.count - a.count);
    const waited = list.filter((item) => !item.background);
    const calls = waited.reduce((sum, item) => sum + item.count, 0);
    const slowest = waited.filter((item) => item.count >= 5).sort((a, b) => (b.p90Ms || 0) - (a.p90Ms || 0))[0] || null;
    return { key, label: labels[key], calls, errors: waited.reduce((sum, item) => sum + item.errors, 0),
      slowest: slowest ? { method: slowest.method, route: slowest.route, label: slowest.label, p90Ms: slowest.p90Ms } : null,
      endpoints: list.map(({ keyOrder, ...item }) => item) };
  }).filter((group) => group.endpoints.length || group.key !== 'other');
}

const SLOT_ORIGIN_MS = Date.parse('2000-01-01T05:00:00Z');

/** Linearly interpolated percentile of ascending numbers (as percentile_cont). @param {number[]} sorted @param {number} fraction */
export function percentileOf(sorted, fraction) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

/** The trend slot (Toronto day or hour) a time falls in. @param {number} atMs @param {number} slotSeconds */
function slotOf(atMs, slotSeconds) {
  const size = slotSeconds * 1000;
  return new Date(SLOT_ORIGIN_MS + Math.floor((atMs - SLOT_ORIGIN_MS) / size) * size).toISOString();
}

/** The PO flow an MBBS request path belongs to. @param {string} path */
export function purchaseOrderFlow(path) {
  const clean = String(path || '').split('?')[0].replace(/\/+$/u, '');
  return PO_FLOWS.find((flow) => flow.patterns.some((pattern) => pattern.test(clean))) || OTHER_PO_FLOW;
}

/** The request a PO write belonged to, and the screen that opens it. @param {string} path */
function purchaseOrderSubject(path) {
  const clean = String(path || '');
  const subjects = [
    [/^\/api\/scm\/special-stock-requests\/(\d+)\//u, (id) => [`Special request ${id}`, `/scm/stock-requests?requestId=${id}`]],
    [/^\/api\/scm\/stock-requests\/(\d+)\/backorder\//u, (id) => [`Backorder request ${id}`, '/scm/stock-requests']],
    [/^\/api\/scm\/netsuite-po-history\/(\d+)/u, (id) => [`PO history ${id}`, `/scm/netsuite-po?historyId=${id}`]],
    [/^\/api\/scm\/smart\/vendor-workflows\/([^/]+)\//u, (id) => [`Vendor workflow ${id}`, '/scm/smart']],
    [/^\/api\/scm\/smart\/netsuite-purchase-orders\/([^/]+)\//u, (id) => [`NetSuite PO review ${id}`, '/scm/smart']]
  ];
  for (const [pattern, describe] of subjects) {
    const match = clean.match(pattern);
    if (match) {
      const [orderRef, link] = describe(match[1]);
      return { orderRef, link };
    }
  }
  return { orderRef: null, link: purchaseOrderFlow(clean).link };
}

/** Sums request-timing histograms of the given method + route pairs.
 * @param {{method: string, route: string, maxMs: number | null, buckets: number[]}[]} rows @param {string[][]} routes @param {number} size */
function sumTimings(rows, routes, size) {
  const wanted = new Set(routes.map(([method, route]) => `${method} ${route}`));
  const buckets = new Array(size).fill(0);
  let maxMs = 0;
  for (const row of rows) {
    if (!wanted.has(`${row.method} ${row.route}`)) continue;
    maxMs = Math.max(maxMs, row.maxMs || 0);
    row.buckets.forEach((value, index) => { buckets[index] += value; });
  }
  return { buckets, maxMs, count: buckets.reduce((sum, value) => sum + value, 0) };
}

/** Purchase orders the app created or changed in NetSuite: NetSuite time per MBBS request (all PO writes
 * of one request summed), the route's server time from request timings, and failed PO writes.
 * @param {{from: string, to: string, slotSeconds: number}} range
 * @param {Awaited<ReturnType<typeof listRequestTimings>>} timings */
export async function listPurchaseOrderPerformance({ from, to, slotSeconds }, timings) {
  const [writes, failed] = await Promise.all([
    query(
      `SELECT COALESCE(s.request_id, 'event-' || s.id) AS request_key, min(s.occurred_at) AS at,
              max(s.details->>'requestPath') AS request_path, count(*)::int AS calls,
              sum(COALESCE(s.duration_ms, 0))::bigint AS ns_ms,
              max(COALESCE(NULLIF(s.details->>'createdRecordId', ''), NULLIF(s.details->>'recordId', ''))) AS po_id,
              max(COALESCE(o.display_name, o.username, s.actor_name)) AS actor
         FROM system_audit_events s
         LEFT JOIN operators o ON o.id = s.actor_operator_id
        WHERE s.occurred_at >= $1::timestamptz AND s.occurred_at < $2::timestamptz AND s.category = 'netsuite'
          AND s.action IN ('netsuite.purchaseorder.created', 'netsuite.purchaseorder.updated')
        GROUP BY 1 ORDER BY 2 DESC LIMIT 5000`, [from, to]),
    // One failed NetSuite call writes a netsuite_http and a netsuite_operation row; count the operation.
    query(
      `SELECT created_at AS at, details->>'requestPath' AS request_path,
              LEFT(COALESCE(NULLIF(details->>'errorMessage', ''), details->>'errorCode', ''), 300) AS error
         FROM delivery_audit_log
        WHERE action = 'netsuite.attempt.failed' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
          AND details->>'stage' = 'netsuite_operation' AND details->>'method' IN ('POST', 'PATCH', 'PUT', 'DELETE')
          AND details->>'path' ~* '/record/v1/purchaseorder' AND details->>'path' !~ '!transform'
        ORDER BY created_at DESC LIMIT 1000`, [from, to])
  ]);
  /** @type {Map<string, {flow: any, ns: number[], failed: number}>} */
  const flows = new Map();
  const entry = (flow) => {
    if (!flows.has(flow.key)) flows.set(flow.key, { flow, ns: [], failed: 0 });
    return flows.get(flow.key);
  };
  const actions = writes.rows.map((row) => {
    const flow = purchaseOrderFlow(row.request_path);
    entry(flow).ns.push(Number(row.ns_ms));
    return { flow, row };
  });
  for (const row of failed.rows) entry(purchaseOrderFlow(row.request_path)).failed += 1;

  const size = timings.edgesMs.length + 1;
  const rows = [...flows.values()].map(({ flow, ns, failed: failedCount }) => {
    const sorted = [...ns].sort((a, b) => a - b);
    const total = sumTimings(timings.rows, flow.routes, size);
    /** @type {Map<string, any[]>} */
    const slots = new Map();
    for (const point of timings.trend) {
      if (!flow.routes.some(([method, route]) => method === point.method && route === point.route)) continue;
      if (!slots.has(point.at)) slots.set(point.at, []);
      slots.get(point.at).push(point);
    }
    const trend = [...slots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([at, points]) => {
      const sum = sumTimings(points, flow.routes, size);
      return { at, count: sum.count, p50Ms: timingPercentile(sum.buckets, 0.5, sum.maxMs) };
    });
    return {
      key: `PO|${flow.key}|PO`, type: 'PO', label: flow.label, source: flow.source, link: flow.link,
      posted: ns.length, failed: failedCount, retried: null,
      nsP50Ms: percentileOf(sorted, 0.5), nsP90Ms: percentileOf(sorted, 0.9), nsMaxMs: sorted.length ? sorted[sorted.length - 1] : null,
      totalP50Ms: total.count ? timingPercentile(total.buckets, 0.5, total.maxMs) : null,
      totalP90Ms: total.count ? timingPercentile(total.buckets, 0.9, total.maxMs) : null,
      totalMaxMs: total.count ? total.maxMs : null, trend
    };
  });

  const slowest = actions.sort((a, b) => Number(b.row.ns_ms) - Number(a.row.ns_ms)).slice(0, 15);
  const ids = [...new Set(slowest.map(({ row }) => row.po_id).filter((id) => /^\d{1,15}$/u.test(String(id || ''))))];
  const refs = new Map(ids.length ? (await query(
    `SELECT netsuite_purchase_order_id::text AS id, netsuite_purchase_order_ref AS ref
       FROM scm_netsuite_po_history WHERE netsuite_purchase_order_id = ANY($1::bigint[])`, [ids])).rows.map((row) => [row.id, row.ref]) : []);
  return {
    rows,
    slowest: slowest.map(({ flow, row }) => {
      const subject = purchaseOrderSubject(row.request_path);
      return { type: 'PO', label: flow.label, source: flow.source, at: new Date(row.at).toISOString(), orderRef: subject.orderRef,
        recordRef: refs.get(String(row.po_id)) || (row.po_id ? `PO #${row.po_id}` : null), actor: row.actor || null,
        attempts: null, totalMs: null, nsMs: ms(row.ns_ms), link: subject.link };
    }),
    failures: failed.rows.slice(0, 15).map((row) => {
      const flow = purchaseOrderFlow(row.request_path);
      const subject = purchaseOrderSubject(row.request_path);
      return { type: 'PO', label: flow.label, source: flow.source, at: new Date(row.at).toISOString(), orderRef: subject.orderRef,
        outcome: 'failed', error: row.error || null, nsMs: null, link: subject.link };
    })
  };
}

const DRIVER_STEPS = Object.freeze([
  ['job_validated', 'Job checked'], ['location_verified', 'Location checked'], ['evidence_committed', 'Saved'],
  ['next_job_started', 'Next job started'], ['response_ready', 'Reply ready']
]);
const OFFLINE_REVIEW = ['review_required', 'blocked', 'resolution_pending'];
const OFFLINE_WAITING = ['registered', 'waiting_photos', 'pending', 'applying'];

/** Driver job completion: online completions (server time, steps, rejections, failures), offline completions
 * (device tap -> server received -> applied), photo upload failures and recent errors.
 * @param {{from: string, to: string, slotSeconds: number}} range */
export async function listDriverCompletionPerformance({ from, to, slotSeconds }) {
  const params = [from, to];
  const offlineTimes = `
    SELECT status, occurrence_time_valid, server_received_at,
           GREATEST(0, EXTRACT(EPOCH FROM (server_received_at - device_occurred_at)) * 1000) AS upload_ms,
           CASE WHEN status = 'applied' AND server_applied_at IS NOT NULL
                THEN GREATEST(0, EXTRACT(EPOCH FROM (server_applied_at - server_received_at)) * 1000) END AS apply_ms,
           CASE WHEN status = 'applied' AND server_applied_at IS NOT NULL AND occurrence_time_valid
                THEN GREATEST(0, EXTRACT(EPOCH FROM (server_applied_at - device_occurred_at)) * 1000) END AS total_ms
      FROM driver_offline_events
     WHERE event_type = 'job_completed' AND server_received_at >= $1::timestamptz AND server_received_at < $2::timestamptz`;
  const finished = `
    SELECT created_at, details->>'requestId' AS request_id, NULLIF(details->>'httpStatus', '')::int AS status,
           NULLIF(details->>'elapsedMs', '')::numeric AS elapsed_ms, details->'steps' AS steps
      FROM delivery_audit_log
     WHERE action = 'driver.job.response_finished' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`;
  const [online, steps, onlineTrend, offline, offlineTrend, photos, offlinePhotos, recent] = await Promise.all([
    query(
      `WITH finished AS (${finished}),
            failed AS (SELECT details->>'requestId' AS request_id FROM delivery_audit_log
                        WHERE action = 'driver.job.completion_failed' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz)
       SELECT count(*) FILTER (WHERE status BETWEEN 200 AND 299)::int AS done,
              count(*) FILTER (WHERE status BETWEEN 400 AND 499)::int AS rejected,
              (SELECT count(*)::int FROM (SELECT request_id FROM finished WHERE status >= 500 UNION SELECT request_id FROM failed) AS f) AS failed,
              (SELECT count(*)::int FROM delivery_audit_log WHERE action = 'driver.job.connection_closed'
                 AND created_at >= $1::timestamptz AND created_at < $2::timestamptz) AS lost,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms) FILTER (WHERE status BETWEEN 200 AND 299) AS p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY elapsed_ms) FILTER (WHERE status BETWEEN 200 AND 299) AS p90,
              max(elapsed_ms) FILTER (WHERE status BETWEEN 200 AND 299) AS max
         FROM finished`, params),
    query(
      `WITH finished AS (${finished})
       SELECT step->>'step' AS step, percentile_cont(0.5) WITHIN GROUP (ORDER BY NULLIF(step->>'elapsedMs', '')::numeric) AS p50
         FROM finished
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(steps) = 'array' THEN steps ELSE '[]'::jsonb END) AS step
        WHERE status BETWEEN 200 AND 299
        GROUP BY 1`, params),
    query(
      `WITH finished AS (${finished})
       SELECT date_bin(make_interval(secs => $3::int), created_at, ${SLOT_ORIGIN}) AS slot_at, count(*)::int AS count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms) AS p50
         FROM finished WHERE status BETWEEN 200 AND 299 GROUP BY 1 ORDER BY 1`, [from, to, slotSeconds]),
    query(
      `WITH e AS (${offlineTimes})
       SELECT count(*)::int AS received,
              count(*) FILTER (WHERE status = 'applied')::int AS applied,
              count(*) FILTER (WHERE status = ANY($3::text[]))::int AS review,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              count(*) FILTER (WHERE status = 'evidence_only')::int AS evidence_only,
              count(*) FILTER (WHERE status = ANY($4::text[]))::int AS waiting,
              count(*) FILTER (WHERE NOT occurrence_time_valid)::int AS invalid_device_time,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY upload_ms) FILTER (WHERE occurrence_time_valid) AS upload_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY upload_ms) FILTER (WHERE occurrence_time_valid) AS upload_p90,
              max(upload_ms) FILTER (WHERE occurrence_time_valid) AS upload_max,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY apply_ms) AS apply_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY apply_ms) AS apply_p90, max(apply_ms) AS apply_max,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS total_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY total_ms) AS total_p90, max(total_ms) AS total_max
         FROM e`, [from, to, OFFLINE_REVIEW, OFFLINE_WAITING]),
    query(
      `WITH e AS (${offlineTimes})
       SELECT date_bin(make_interval(secs => $3::int), server_received_at, ${SLOT_ORIGIN}) AS slot_at, count(*)::int AS count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50
         FROM e GROUP BY 1 ORDER BY 1`, [from, to, slotSeconds]),
    query(
      `SELECT details->>'stage' AS stage,
              count(*) FILTER (WHERE action = 'driver.photo_upload.failed')::int AS failed,
              count(*) FILTER (WHERE action = 'driver.photo_upload.recovered')::int AS recovered
         FROM delivery_audit_log
        WHERE action IN ('driver.photo_upload.failed', 'driver.photo_upload.recovered')
          AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
        GROUP BY 1 ORDER BY 2 DESC, 1`, params),
    query(
      `SELECT count(*)::int AS photos,
              count(*) FILTER (WHERE status = 'durably_received')::int AS durable,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              count(*) FILTER (WHERE status <> 'durably_received' AND last_verification_error <> '')::int AS verification_errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (durable_received_at - created_at)) * 1000)
                FILTER (WHERE durable_received_at IS NOT NULL) AS durable_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (durable_received_at - created_at)) * 1000)
                FILTER (WHERE durable_received_at IS NOT NULL) AS durable_p90
         FROM driver_offline_event_photos
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, params),
    query(
      `(SELECT created_at AS at, 'completion_failed' AS kind, details->>'driverLogin' AS driver, details->>'jobId' AS job_id,
               COALESCE(details->>'code', '') AS code, LEFT(COALESCE(details->>'error', ''), 300) AS error
          FROM delivery_audit_log
         WHERE action = 'driver.job.completion_failed' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
         ORDER BY created_at DESC LIMIT 15)
       UNION ALL
       (SELECT created_at, 'connection_closed', details->>'driverLogin', details->>'jobId', COALESCE(details->>'lastStep', ''), ''
          FROM delivery_audit_log
         WHERE action = 'driver.job.connection_closed' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
         ORDER BY created_at DESC LIMIT 15)
       UNION ALL
       (SELECT created_at, 'photo_upload', details->>'driverLogin', details->>'jobId', COALESCE(details->>'stage', ''),
               LEFT(COALESCE(NULLIF(details->>'message', ''), details->>'errorCode', ''), 300)
          FROM delivery_audit_log
         WHERE action = 'driver.photo_upload.failed' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
         ORDER BY created_at DESC LIMIT 15)
       UNION ALL
       (SELECT updated_at, 'offline_' || status, driver_login, COALESCE(effective_job_id, original_job_id),
               COALESCE(application_result->>'code', ''), LEFT(COALESCE(review_reason, ''), 300)
          FROM driver_offline_events
         WHERE event_type = 'job_completed' AND status IN ('review_required', 'blocked', 'resolution_pending', 'rejected')
           AND server_received_at >= $1::timestamptz AND server_received_at < $2::timestamptz
         ORDER BY updated_at DESC LIMIT 15)
       ORDER BY 1 DESC LIMIT 15`, params)
  ]);
  const onlineRow = online.rows[0];
  const stepTimes = new Map(steps.rows.map((row) => [row.step, ms(row.p50)]));
  const offlineRow = offline.rows[0];
  const photoRow = offlinePhotos.rows[0];
  const trend = (rows) => rows.map((row) => ({ at: new Date(row.slot_at).toISOString(), count: row.count, p50Ms: ms(row.p50) }));
  return {
    online: {
      done: onlineRow.done, rejected: onlineRow.rejected, failed: onlineRow.failed, lostConnection: onlineRow.lost,
      p50Ms: ms(onlineRow.p50), p90Ms: ms(onlineRow.p90), maxMs: ms(onlineRow.max),
      steps: DRIVER_STEPS.filter(([key]) => stepTimes.has(key)).map(([key, label]) => ({ key, label, p50Ms: stepTimes.get(key) })),
      trend: trend(onlineTrend.rows)
    },
    offline: {
      received: offlineRow.received, applied: offlineRow.applied, review: offlineRow.review, rejected: offlineRow.rejected,
      evidenceOnly: offlineRow.evidence_only, waiting: offlineRow.waiting, invalidDeviceTime: offlineRow.invalid_device_time,
      uploadP50Ms: ms(offlineRow.upload_p50), uploadP90Ms: ms(offlineRow.upload_p90), uploadMaxMs: ms(offlineRow.upload_max),
      applyP50Ms: ms(offlineRow.apply_p50), applyP90Ms: ms(offlineRow.apply_p90), applyMaxMs: ms(offlineRow.apply_max),
      totalP50Ms: ms(offlineRow.total_p50), totalP90Ms: ms(offlineRow.total_p90), totalMaxMs: ms(offlineRow.total_max),
      trend: trend(offlineTrend.rows)
    },
    photos: {
      uploadFailures: photos.rows.map((row) => ({ stage: row.stage || '', failed: row.failed, recovered: row.recovered })),
      offline: { photos: photoRow.photos, durable: photoRow.durable, rejected: photoRow.rejected,
        verificationErrors: photoRow.verification_errors, durableP50Ms: ms(photoRow.durable_p50), durableP90Ms: ms(photoRow.durable_p90) }
    },
    recent: recent.rows.map((row) => ({ at: new Date(row.at).toISOString(), kind: row.kind, driver: row.driver || null,
      jobId: row.job_id || null, code: row.code || null, error: row.error || null }))
  };
}

/** What is waiting for someone right now (independent of the range), per card, with where to fix it. */
export async function listAttentionNow() {
  const [counts, driverCounts, clientIssues] = await Promise.all([
    query(
      // "failed" operator commands and Smart SCM proposals are final: count recent ones, not years of history.
      `SELECT
         (SELECT count(*)::int FROM operator_netsuite_posting_commands WHERE transaction_type = 'IF'
            AND (status = 'attention' OR (status = 'failed' AND updated_at >= now() - interval '7 days'))) AS operator_if,
         (SELECT count(*)::int FROM operator_netsuite_posting_commands WHERE transaction_type = 'IR'
            AND (status = 'attention' OR (status = 'failed' AND updated_at >= now() - interval '7 days'))) AS operator_ir,
         (SELECT count(*)::int FROM dispatch_sales_order_if_candidates WHERE status = 'attention') AS so_if,
         (SELECT count(*)::int FROM dispatch_direct_po_ir_jobs WHERE status = 'attention') AS direct_po_ir,
         (SELECT count(*)::int FROM sales_special_stock_cases WHERE purchase_order_operation_status = 'attention') AS special_po,
         (SELECT count(*)::int FROM sales_special_stock_cases
           WHERE quantity_review->>'status' = 'attention' OR closure_review->>'status' = 'attention') AS special_review,
         (SELECT count(*)::int FROM sales_special_stock_order_lines WHERE po_sync_status = 'attention') AS special_items,
         (SELECT count(*)::int FROM scm_smart_proposals WHERE po_execution_status = 'attention'
            OR (po_execution_status = 'failed' AND updated_at >= now() - interval '30 days')) AS smart_po,
         (SELECT count(*)::int FROM scm_netsuite_po_history WHERE COALESCE(last_sync_error, '') <> ''
            AND last_sync_error <> 'The purchase order no longer exists in NetSuite.') AS po_history,
         (SELECT count(*)::int FROM return_batch_authorizations WHERE sync_status = 'failed'
            AND COALESCE(intent_snapshot->>'transactionType', 'credit_memo') = 'credit_memo') AS cm`),
    getDriverOfflineReviewCounts(),
    listDriverClientSyncIssues({ limit: 500 })
  ]);
  const row = counts.rows[0];
  const item = (key, label, count, link) => ({ key, label, count: Number(count || 0), link });
  // Same numbers as the Dispatch menu's Driver PWA badge (/api/dispatch/offline-review/count).
  const driverAction = driverCounts.actionRequiredCount + clientIssues.length;
  return {
    IF: [item('operator_if', 'Operator IF postings', row.operator_if, '/admin/mbt-gates'),
      item('so_if', 'SO auto-fulfillment', row.so_if, '/admin/mbt-gates')],
    IR: [item('operator_ir', 'Operator IR postings', row.operator_ir, '/admin/mbt-gates'),
      item('direct_po_ir', 'Direct PO receipts', row.direct_po_ir, '/admin/audit')],
    PO: [item('special_po', 'Special Item PO create', row.special_po, '/scm/stock-requests'),
      item('special_review', 'Special quantity / closure review', row.special_review, '/scm/stock-requests'),
      item('special_items', 'Special PO items', row.special_items, '/scm/stock-requests'),
      item('smart_po', 'Smart SCM PO create', row.smart_po, '/scm/smart'),
      item('po_history', 'PO edit (sync error)', row.po_history, '/scm/netsuite-po')],
    CM: [item('cm', 'Credit memos', row.cm, '/control/returns')],
    Driver: [item('driver_review', 'Driver sync to review', driverAction, '/dispatch-offline-review.html'),
      item('driver_syncing', 'Driver events still syncing', driverCounts.syncInProgressCount, '/dispatch-offline-review.html')]
  };
}

const SUMMARY_TYPES = ['IF', 'IR', 'PO', 'CM', 'Driver'];

/** One card per type: done and failed in the range, the slowest 90% time, and what needs attention now. */
export function buildPerformanceSummary(postings, driver, attention) {
  return SUMMARY_TYPES.map((type) => {
    const waiting = (attention[type] || []).filter((item) => item.count > 0 && item.key !== 'driver_syncing');
    const card = { type, done: 0, failed: 0, slowest: null, attention: waiting.reduce((sum, item) => sum + item.count, 0), attentionItems: waiting };
    if (type === 'Driver') {
      card.done = driver.online.done + driver.offline.applied;
      card.failed = driver.online.failed + driver.offline.review + driver.offline.rejected;
      const times = [['Online completion', driver.online.p90Ms], ['Offline completion', driver.offline.totalP90Ms]]
        .filter(([, value]) => value !== null);
      const [label, p90Ms] = times.sort((a, b) => Number(b[1]) - Number(a[1]))[0] || [];
      card.slowest = label ? { label, p90Ms } : null;
      return card;
    }
    const rows = postings.rows.filter((row) => row.type === type);
    card.done = rows.reduce((sum, row) => sum + row.posted, 0);
    card.failed = rows.reduce((sum, row) => sum + row.failed, 0);
    const timed = rows.map((row) => ({ label: row.label, p90Ms: row.totalP90Ms ?? row.nsP90Ms })).filter((row) => row.p90Ms !== null);
    card.slowest = timed.sort((a, b) => b.p90Ms - a.p90Ms)[0] || null;
    return card;
  });
}

/** The Admin -> Performance payload. @param {{range?: string, from?: string, to?: string}} [input] */
export async function getPerformanceReport(input = {}) {
  const range = performanceRange(input);
  const poRoutes = PO_FLOWS.flatMap((flow) => flow.routes.map(([, route]) => route));
  const [postings, timings, driver, attention] = await Promise.all([
    listPostingPerformance(range),
    listRequestTimings({ from: range.from, to: range.to, trendRoutes: [...KEY_ENDPOINTS.map(([, route]) => route), ...poRoutes] }),
    listDriverCompletionPerformance(range),
    listAttentionNow()
  ]);
  const po = await listPurchaseOrderPerformance(range, timings);
  const order = (key) => (POSTING_ORDER.includes(key) ? POSTING_ORDER.indexOf(key) : POSTING_ORDER.length);
  const merged = {
    rows: [...postings.rows, ...po.rows].sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label)),
    slowest: [...postings.slowest, ...po.slowest]
      .sort((a, b) => Number(b.totalMs ?? b.nsMs) - Number(a.totalMs ?? a.nsMs)).slice(0, 15),
    failures: [...postings.failures, ...po.failures].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15)
  };
  return { ...range, postings: merged, driver, attention, summary: buildPerformanceSummary(merged, driver, attention),
    pages: groupRequestTimings(timings), pagesRecordedSince: timings.firstAt, timingEdgesMs: timings.edgesMs };
}
