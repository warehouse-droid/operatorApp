// @ts-check
// Request timing: how long the server takes for every page and API call, kept 14 days for
// Admin -> Performance. Each request's time (from arrival to the last response byte, as measured
// by the system audit middleware) goes into an in-memory histogram per 5-minute bucket, method,
// route, calling page (Referer) and status class; every 60 s the histograms are merged into
// system_request_timings. Percentiles are read back from the summed histograms.
import pg from 'pg';
import { config } from './config.js';
import { query } from './db.js';
import { auditRoute, requestDurationMs } from './system-audit.js';

export const TIMING_BUCKET_MS = 5 * 60_000;
const FLUSH_MS = 60_000;
const RETENTION_DAYS = 14;
const MAX_KEYS = 3000;
// Upper edges (ms) of the histogram buckets; one more bucket holds everything slower.
export const TIMING_EDGES_MS = Object.freeze([100, 250, 500, 1000, 2000, 3000, 5000, 10000, 20000, 30000, 60000]);
const STATIC_FILE = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|json|webmanifest|txt|pdf|wasm)$/iu;
const stderr = console.error.bind(console);

/** Index of the histogram bucket for a duration. @param {number} ms */
export function timingBucketIndex(ms) {
  const index = TIMING_EDGES_MS.findIndex((edge) => ms <= edge);
  return index === -1 ? TIMING_EDGES_MS.length : index;
}

/** Estimated percentile (ms) from bucket counts, interpolating inside the bucket.
 * @param {number[]} buckets @param {number} fraction @param {number} [maxMs] */
export function timingPercentile(buckets, fraction, maxMs = 0) {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  const target = Math.max(1, Math.ceil(total * fraction));
  let seen = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    const count = buckets[index];
    if (!count) continue;
    if (seen + count >= target) {
      const lower = index === 0 ? 0 : TIMING_EDGES_MS[index - 1];
      const upper = index < TIMING_EDGES_MS.length ? TIMING_EDGES_MS[index] : Math.max(maxMs, lower);
      const estimate = lower + ((target - seen) / count) * (upper - lower);
      return Math.round(maxMs ? Math.min(estimate, maxMs) : estimate);
    }
    seen += count;
  }
  return maxMs || null;
}

/** The page a call came from, from the Referer of a same-site request ("" when unknown).
 * @param {string} referer @param {string} host */
export function refererPage(referer, host) {
  if (!referer) return '';
  try {
    const url = new URL(referer);
    if (host && url.host !== host) return '';
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    return path.replace(/\/\d+(?=\/|$)/gu, '/:id').slice(0, 80);
  } catch {
    return '';
  }
}

/** Route label used for a request; null when the request is not timed (static files, HEAD/OPTIONS).
 * @param {import('express').Request} req @param {number | null} status */
export function timedRoute(req, status) {
  if (req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  if (typeof req.route?.path === 'string') return auditRoute(req).slice(0, 200);
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (path.startsWith('/api/')) return '/api/(unmatched)';
  if (STATIC_FILE.test(path)) return null;
  if (status === 404) return '(not found)';
  // Page routes are declared with path lists, so req.route.path is not a string for them.
  return path.replace(/\/+$/u, '').slice(0, 80) || '/';
}

/** @param {{pool?: {query: Function, end?: Function}, now?: () => number, flushMs?: number, enabled?: boolean}} [options] */
export function createRequestTimingRecorder({
  pool = null,
  now = Date.now,
  flushMs = FLUSH_MS,
  enabled = process.env.REQUEST_TIMING !== 'off'
} = {}) {
  /** @type {Map<string, {bucketAt: string, method: string, route: string, page: string, statusClass: string,
   *  count: number, totalMs: number, maxMs: number, buckets: number[]}>} */
  let entries = new Map();
  let timer = null;
  let flushing = null;
  let lastSweepAt = 0;
  let lastFailureAt = 0;
  const ownPool = !pool;
  const db = pool || new pg.Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 120_000,
    statement_timeout: 10_000,
    allowExitOnIdle: true,
    application_name: 'mbbs-request-timing'
  });
  if (ownPool) db.on?.('error', (error) => reportFailure('database connection failed', error));

  function reportFailure(label, error) {
    if (Date.now() - lastFailureAt < 10 * 60_000) return;
    lastFailureAt = Date.now();
    try { stderr(`[request-timing] ${label}:`, error instanceof Error ? error.message : String(error)); } catch { /* ignore */ }
  }

  /** @param {{method: string, route: string, page: string, statusClass: string, durationMs: number, at?: number}} sample */
  function record({ method, route, page, statusClass, durationMs, at = now() }) {
    if (!enabled || !Number.isFinite(durationMs)) return;
    const bucketAt = new Date(Math.floor(at / TIMING_BUCKET_MS) * TIMING_BUCKET_MS).toISOString();
    let key = JSON.stringify([bucketAt, method, route, page, statusClass]);
    let keyRoute = route;
    let keyPage = page;
    if (!entries.has(key) && entries.size >= MAX_KEYS) {
      keyRoute = '(other)';
      keyPage = '';
      key = JSON.stringify([bucketAt, method, keyRoute, keyPage, statusClass]);
    }
    let entry = entries.get(key);
    if (!entry) {
      entry = { bucketAt, method, route: keyRoute, page: keyPage, statusClass, count: 0, totalMs: 0, maxMs: 0,
        buckets: new Array(TIMING_EDGES_MS.length + 1).fill(0) };
      entries.set(key, entry);
    }
    const ms = Math.max(0, Math.round(durationMs));
    entry.count += 1;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
    entry.buckets[timingBucketIndex(ms)] += 1;
  }

  /** Express middleware; mount right after the system audit middleware (it starts the clock).
   * @param {{skip?: (req: import('express').Request) => boolean}} [options] @returns {import('express').RequestHandler} */
  function middleware({ skip = () => false } = {}) {
    return function requestTiming(req, res, next) {
      if (!enabled) return next();
      let settled = false;
      const settle = (/** @type {boolean} */ aborted) => {
        if (settled) return;
        settled = true;
        try {
          if (req.get('x-mbbs-rollback-test') === '1' || skip(req)) return;
          const status = aborted ? null : res.statusCode;
          const route = timedRoute(req, status);
          const durationMs = requestDurationMs(res);
          if (!route || durationMs === null) return;
          const isPage = !route.startsWith('/api/') && req.method === 'GET';
          record({
            method: req.method,
            route,
            page: isPage ? route : refererPage(String(req.get('referer') || ''), String(req.get('host') || '')),
            statusClass: status === null ? 'aborted' : `${Math.floor(status / 100)}xx`,
            durationMs
          });
        } catch (error) {
          reportFailure('request could not be timed', error);
        }
      };
      res.once('finish', () => settle(false));
      res.once('close', () => settle(!res.writableFinished));
      next();
    };
  }

  async function flush() {
    if (flushing) return flushing;
    if (!entries.size) return 0;
    const rows = [...entries.values()].map((entry) => ({
      bucket_at: entry.bucketAt, method: entry.method, route: entry.route, page: entry.page,
      status_class: entry.statusClass, count: entry.count, total_ms: entry.totalMs, max_ms: entry.maxMs, buckets: entry.buckets
    }));
    entries = new Map();
    flushing = (async () => {
      try {
        await db.query(
          `INSERT INTO system_request_timings AS t (bucket_at, method, route, page, status_class, count, total_ms, max_ms, buckets)
           SELECT r.bucket_at, r.method, r.route, r.page, r.status_class, r.count, r.total_ms, r.max_ms,
                  ARRAY(SELECT jsonb_array_elements_text(r.buckets)::int)
             FROM jsonb_to_recordset($1::jsonb) AS r(bucket_at timestamptz, method text, route text, page text,
               status_class text, count integer, total_ms bigint, max_ms integer, buckets jsonb)
           ON CONFLICT (bucket_at, method, route, page, status_class) DO UPDATE SET
             count = t.count + EXCLUDED.count,
             total_ms = t.total_ms + EXCLUDED.total_ms,
             max_ms = GREATEST(t.max_ms, EXCLUDED.max_ms),
             buckets = ARRAY(SELECT COALESCE(a, 0) + COALESCE(b, 0) FROM unnest(t.buckets, EXCLUDED.buckets) AS u(a, b))`,
          [JSON.stringify(rows)]
        );
        if (now() - lastSweepAt >= 3_600_000) {
          lastSweepAt = now();
          await db.query(`DELETE FROM system_request_timings WHERE bucket_at < now() - make_interval(days => ${RETENTION_DAYS})`);
        }
        return rows.length;
      } catch (error) {
        reportFailure('timings could not be saved', error);
        return 0;
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  function start() {
    if (!enabled || timer) return;
    timer = setInterval(() => void flush(), flushMs);
    timer.unref?.();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await flush();
    if (ownPool) await db.end?.();
  }

  return { middleware, record, flush, start, stop, pending: () => entries.size };
}

/** Summed timings per method, route and calling page between from and to, with p50/p90/p95 from the
 * histograms, plus per-slot p90 for the given routes (hourly up to 2 days, daily beyond).
 * @param {{from: string, to: string, trendRoutes?: string[]}} range */
export async function listRequestTimings({ from, to, trendRoutes = [] }) {
  const span = Date.parse(to) - Date.parse(from);
  const slotSeconds = span <= 2 * 86_400_000 ? 3600 : 86_400;
  // Element-wise sums of the successful calls' histograms (cheaper than unnesting every row).
  const histogram = `ARRAY[${TIMING_EDGES_MS.concat(0).map((_, index) =>
    `COALESCE(sum(buckets[${index + 1}]) FILTER (WHERE status_class NOT IN ('5xx', 'aborted')), 0)`).join(', ')}]::int[]`;
  const [rows, trend, first] = await Promise.all([
    query(
      `SELECT method, route, page, sum(count)::int AS count, sum(total_ms)::bigint AS total_ms, max(max_ms) AS max_ms,
              COALESCE(sum(count) FILTER (WHERE status_class IN ('5xx', 'aborted')), 0)::int AS errors,
              COALESCE(sum(count) FILTER (WHERE status_class = '4xx'), 0)::int AS rejected,
              ${histogram} AS buckets
         FROM system_request_timings
        WHERE bucket_at >= $1::timestamptz AND bucket_at < $2::timestamptz
        GROUP BY 1, 2, 3`,
      [from, to]
    ),
    trendRoutes.length ? query(
      `SELECT method, route, date_bin(make_interval(secs => $3::int), bucket_at, TIMESTAMPTZ '2000-01-01 05:00:00+00') AS slot_at,
              max(max_ms) AS max_ms, ${histogram} AS buckets
         FROM system_request_timings
        WHERE bucket_at >= $1::timestamptz AND bucket_at < $2::timestamptz
          AND route = ANY($4::text[]) AND status_class NOT IN ('5xx', 'aborted')
        GROUP BY 1, 2, 3
        ORDER BY 3`,
      [from, to, slotSeconds, trendRoutes]
    ) : Promise.resolve({ rows: [] }),
    query('SELECT min(bucket_at) AS first_at FROM system_request_timings')
  ]);
  return {
    edgesMs: TIMING_EDGES_MS,
    slotSeconds,
    firstAt: first.rows[0]?.first_at ? new Date(first.rows[0].first_at).toISOString() : null,
    rows: rows.rows.map((row) => {
      const buckets = row.buckets.map(Number);
      return {
        method: row.method, route: row.route, page: row.page, count: row.count, errors: row.errors, rejected: row.rejected,
        avgMs: row.count ? Math.round(Number(row.total_ms) / row.count) : null, maxMs: row.max_ms, buckets,
        p50Ms: timingPercentile(buckets, 0.5, row.max_ms), p90Ms: timingPercentile(buckets, 0.9, row.max_ms),
        p95Ms: timingPercentile(buckets, 0.95, row.max_ms)
      };
    }),
    trend: trend.rows.map((row) => {
      const buckets = row.buckets.map(Number);
      return { method: row.method, route: row.route, at: new Date(row.slot_at).toISOString(),
        count: buckets.reduce((sum, value) => sum + value, 0), maxMs: row.max_ms, buckets,
        p50Ms: timingPercentile(buckets, 0.5, row.max_ms), p90Ms: timingPercentile(buckets, 0.9, row.max_ms) };
    })
  };
}
