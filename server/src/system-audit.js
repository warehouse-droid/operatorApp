// @ts-check
// System audit log: records what the rest of the audit trail cannot see —
// failed and slow requests, background-job and process logs, crashes,
// successful NetSuite postings, and browser errors. Rows go to
// system_audit_events through a small dedicated pool so a rolled-back business
// transaction or a saturated main pool never erases the evidence of a failure.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import util from 'node:util';
import express from 'express';
import pg from 'pg';
import { currentAuditRequest, runWithAuditRequest } from './audit-context.js';
import { config } from './config.js';
import { sanitizeNetSuiteFailureText } from './netsuite-failure-audit.js';

export const SYSTEM_AUDIT_CATEGORIES = Object.freeze(['request', 'netsuite', 'system', 'client']);
export const SYSTEM_AUDIT_SEVERITIES = Object.freeze(['info', 'warning', 'error', 'critical']);
const CATEGORY_SET = new Set(SYSTEM_AUDIT_CATEGORIES);
const SEVERITY_SET = new Set(SYSTEM_AUDIT_SEVERITIES);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SENSITIVE_KEY = /(password|passcode|passphrase|private[_ -]?key|api[_ -]?key|credential|token|secret|authorization|cookie|signature|photo|image|base64|data_?url)/i;
const MAX_QUEUE = 5000;
const BATCH_SIZE = 200;
const FLUSH_MS = 500;
const LIMIT_WINDOW_MS = 60_000;
const CRASH_FILE = new URL('../data/system-audit-crash.ndjson', import.meta.url);

const recordedErrors = new WeakSet();
const stderr = console.error.bind(console);

/** @type {{enabled: boolean, processName: string, queue: Record<string, any>[], dropped: number,
 *  timer: NodeJS.Timeout | null, flushing: Promise<void> | null, failures: number, pool: pg.Pool | null,
 *  insert: ((rows: Record<string, any>[]) => Promise<unknown>) | null, consoleInstalled: boolean,
 *  processHooksInstalled: boolean, capturing: boolean, sweepTimer: NodeJS.Timeout | null}} */
const state = {
  enabled: process.env.MBBS_SYSTEM_AUDIT !== 'off',
  processName: 'app',
  queue: [],
  dropped: 0,
  timer: null,
  flushing: null,
  failures: 0,
  pool: null,
  insert: null,
  consoleInstalled: false,
  processHooksInstalled: false,
  capturing: false,
  sweepTimer: null
};

/** @type {Map<string, {windowStart: number, count: number, suppressed: number, sample: Record<string, any>}>} */
const limiter = new Map();

/** @param {unknown} value @param {number} [limit] */
function text(value, limit = 1000) {
  return sanitizeNetSuiteFailureText(value ?? '', limit);
}

/** @param {unknown} value */
function optionalText(value, limit = 1000) {
  const result = text(value, limit).trim();
  return result || null;
}

/** @param {unknown} value */
function optionalInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(Math.min(Math.round(number), 2_147_483_647), -2_147_483_648) : null;
}

/** Redacts secrets and photo data and bounds the size of arbitrary values.
 * @param {unknown} value @param {string} [key] @param {number} [depth] @returns {any} */
export function sanitizeAuditDetails(value, key = '', depth = 0) {
  if (SENSITIVE_KEY.test(String(key || ''))) {
    return Array.isArray(value) ? `[REDACTED (${value.length} values)]` : '[REDACTED]';
  }
  if (value === null || value === undefined || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value)) return '[REDACTED IMAGE]';
    return text(value, 1000);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return { name: value.name, message: text(value.message, 1000) };
  if (Buffer.isBuffer(value)) return `[BINARY ${value.length} bytes]`;
  // Six levels keep posted NetSuite lines (payload.item.items[n].field) readable.
  if (depth >= 6) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 25).map((entry) => sanitizeAuditDetails(entry, key, depth + 1));
    if (value.length > 25) items.push(`[${value.length - 25} more values]`);
    return items;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, 50);
    /** @type {Record<string, any>} */
    const sanitized = Object.fromEntries(entries.map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeAuditDetails(entryValue, entryKey, depth + 1)
    ]));
    if (Object.keys(value).length > 50) sanitized._truncated = true;
    return sanitized;
  }
  return text(String(value), 1000);
}

/** @param {string} label @param {unknown} error */
function reportInternalFailure(label, error) {
  try {
    stderr(`[system-audit] ${label}:`, error instanceof Error ? error.message : String(error));
  } catch { /* Diagnostics must never break the application. */ }
}

/** Overrides defaults; used by entrypoints and tests.
 * @param {{enabled?: boolean, processName?: string, insert?: ((rows: Record<string, any>[]) => Promise<unknown>) | null}} [options] */
export function configureSystemAudit(options = {}) {
  if (typeof options.enabled === 'boolean') state.enabled = options.enabled;
  if (options.processName) state.processName = text(options.processName, 60);
  if (options.insert !== undefined) state.insert = options.insert;
}

function auditPool() {
  if (!state.pool) {
    state.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 2,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 5000,
      allowExitOnIdle: true,
      application_name: 'mbbs-system-audit'
    });
    state.pool.on('error', (error) => reportInternalFailure('database connection failed', error));
  }
  return state.pool;
}

/** @param {Record<string, any>[]} rows */
async function insertRows(rows) {
  if (state.insert) return state.insert(rows);
  return auditPool().query(
    `INSERT INTO system_audit_events (
       occurred_at, category, severity, source, action, outcome, actor_type, actor_operator_id,
       actor_name, process_name, request_id, http_method, route, status_code, duration_ms,
       order_ref, message, error_code, repeat_count, details
     )
     SELECT occurred_at, category, severity, source, action, outcome, actor_type, actor_operator_id,
            actor_name, process_name, request_id, http_method, route, status_code, duration_ms,
            order_ref, message, error_code, repeat_count, COALESCE(details, '{}'::jsonb)
       FROM jsonb_to_recordset($1::jsonb) AS r(
         occurred_at timestamptz, category text, severity text, source text, action text,
         outcome text, actor_type text, actor_operator_id text, actor_name text, process_name text,
         request_id text, http_method text, route text, status_code integer, duration_ms integer,
         order_ref text, message text, error_code text, repeat_count integer, details jsonb
       )`,
    [JSON.stringify(rows)]
  );
}

function scheduleFlush(delay = FLUSH_MS) {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushSystemAudit();
  }, delay);
  state.timer.unref?.();
}

/** Writes every queued event. Safe to call concurrently. */
export function flushSystemAudit() {
  if (state.flushing) return state.flushing;
  state.flushing = (async () => {
    while (state.queue.length || state.dropped) {
      const batch = state.queue.splice(0, BATCH_SIZE);
      if (state.dropped) {
        batch.push(buildRow({
          category: 'system', severity: 'warning', source: 'system-audit', action: 'system.audit.dropped',
          message: `${state.dropped} audit event(s) were dropped because the audit queue was full.`,
          repeatCount: state.dropped
        }));
        state.dropped = 0;
      }
      try {
        await insertRows(batch);
        state.failures = 0;
      } catch (error) {
        state.failures += 1;
        if (state.failures <= 3) {
          state.queue.unshift(...batch.slice(0, Math.max(MAX_QUEUE - state.queue.length, 0)));
          reportInternalFailure(`write failed (attempt ${state.failures}); retrying`, error);
          return;
        }
        reportInternalFailure(`write failed ${state.failures} times; ${batch.length} event(s) sent to stderr`, error);
        for (const row of batch) {
          try { stderr(JSON.stringify({ systemAuditFallback: true, ...row })); } catch { /* ignore */ }
        }
        state.failures = 0;
      }
    }
  })().finally(() => {
    state.flushing = null;
    if (state.queue.length) scheduleFlush(state.failures ? FLUSH_MS * 2 ** state.failures : FLUSH_MS);
  });
  return state.flushing;
}

/** Flushes and closes the dedicated pool (tests and graceful shutdown). */
export async function closeSystemAudit() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  sweepLimiter(true);
  await flushSystemAudit();
  const pool = state.pool;
  state.pool = null;
  if (pool) await pool.end();
}

/** @param {any} store */
function actorFromRequest(store) {
  const req = store?.req;
  if (!req) return {};
  if (req.operator) {
    return {
      actorType: 'operator',
      actorOperatorId: String(req.operator.id || '') || null,
      actorName: req.operator.display_name || req.operator.username || ''
    };
  }
  if (req.driver) return { actorType: 'driver', actorName: req.driver.name || req.driver.login || '' };
  return null;
}

/** @param {Record<string, any>} event */
function buildRow(event) {
  const store = currentAuditRequest();
  const actor = event.actorType ? null : actorFromRequest(store);
  const occurredAt = Number.isFinite(Date.parse(event.occurredAt)) ? new Date(event.occurredAt) : new Date();
  return {
    occurred_at: occurredAt.toISOString(),
    category: CATEGORY_SET.has(event.category) ? event.category : 'system',
    severity: SEVERITY_SET.has(event.severity) ? event.severity : 'info',
    source: optionalText(event.source, 80) || 'system',
    action: optionalText(event.action, 160) || 'system.event',
    outcome: optionalText(event.outcome, 40),
    actor_type: optionalText(event.actorType || actor?.actorType, 40) || (store?.req ? 'anonymous' : 'system'),
    actor_operator_id: optionalText(event.actorOperatorId ?? actor?.actorOperatorId, 120),
    actor_name: optionalText(event.actorName ?? actor?.actorName, 160),
    process_name: state.processName,
    request_id: optionalText(event.requestId || store?.requestId, 120),
    http_method: optionalText(event.method, 12),
    route: optionalText(event.route, 300),
    status_code: optionalInteger(event.statusCode),
    duration_ms: optionalInteger(event.durationMs),
    order_ref: optionalText(event.orderRef, 180),
    message: optionalText(event.message, 4000),
    error_code: optionalText(event.errorCode, 160),
    repeat_count: Math.max(optionalInteger(event.repeatCount) || 1, 1),
    details: sanitizeAuditDetails(event.details || {})
  };
}

/** Queues one event; never throws and never waits for the database.
 * @param {{category?: string, severity?: string, source?: string, action: string, outcome?: string,
 *  actorType?: string, actorOperatorId?: string | null, actorName?: string, requestId?: string,
 *  method?: string, route?: string, statusCode?: number, durationMs?: number, orderRef?: string,
 *  message?: string, errorCode?: string, repeatCount?: number, occurredAt?: string,
 *  details?: Record<string, any>}} event */
export function recordSystemEvent(event) {
  if (!state.enabled) return null;
  try {
    const row = buildRow(event);
    if (state.queue.length >= MAX_QUEUE) {
      state.dropped += 1;
    } else {
      state.queue.push(row);
    }
    scheduleFlush();
    return row;
  } catch (error) {
    reportInternalFailure('event could not be queued', error);
    return null;
  }
}

/** Allows the first `max` events per key per minute and reports the rest as one summary row.
 * @param {string} key @param {number} max @param {Record<string, any>} event */
function recordLimited(key, max, event) {
  const now = Date.now();
  const entry = limiter.get(key);
  if (!entry || now - entry.windowStart >= LIMIT_WINDOW_MS) {
    if (entry?.suppressed) emitSuppressed(entry);
    limiter.set(key, { windowStart: now, count: 1, suppressed: 0, sample: event });
    return recordSystemEvent(event);
  }
  entry.count += 1;
  if (entry.count <= max) return recordSystemEvent(event);
  entry.suppressed += 1;
  return null;
}

/** @param {{suppressed: number, sample: Record<string, any>}} entry */
function emitSuppressed(entry) {
  recordSystemEvent({
    ...entry.sample,
    action: `${entry.sample.action}.repeated`,
    message: `Repeated ${entry.suppressed} more time(s) within one minute: ${entry.sample.message || entry.sample.action}`,
    repeatCount: entry.suppressed
  });
}

function sweepLimiter(all = false) {
  const now = Date.now();
  for (const [key, entry] of limiter) {
    if (all || now - entry.windowStart >= LIMIT_WINDOW_MS) {
      if (entry.suppressed) emitSuppressed(entry);
      limiter.delete(key);
    }
  }
}

function startLimiterSweep() {
  if (state.sweepTimer) return;
  state.sweepTimer = setInterval(() => sweepLimiter(), LIMIT_WINDOW_MS);
  state.sweepTimer.unref?.();
}

/** @param {string} message */
function limiterKey(message) {
  return String(message || '')
    .split('\n', 1)[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '<id>')
    .replace(/\d+/gu, '#')
    .slice(0, 200);
}

/** Marks an error as already audited so the console capture does not record it twice.
 * @param {unknown} error */
export function markErrorAudited(error) {
  if (error && typeof error === 'object') recordedErrors.add(error);
}

/** Called by the final Express error handler before it responds.
 * @param {import('express').Response} res @param {any} error */
export function noteRequestError(res, error) {
  const status = Number(error?.status || error?.statusCode || 500);
  res.locals.auditError = {
    message: text(error?.message || error || 'Request failed.', 4000),
    code: text(error?.code || '', 160),
    name: text(error?.name || 'Error', 80),
    ...(status >= 500 ? { stack: text(error?.stack || '', 4000) } : {})
  };
  markErrorAudited(error);
}

/** Elapsed milliseconds for a request that passed through the request middleware.
 * @param {import('express').Response} res */
export function requestDurationMs(res) {
  const startedAt = res.locals?.auditStartedAt;
  return typeof startedAt === 'bigint' ? Number((process.hrtime.bigint() - startedAt) / 1_000_000n) : null;
}

/** @param {import('express').Request} req */
export function auditRoute(req) {
  const routePath = typeof req.route?.path === 'string' ? req.route.path : '';
  return routePath ? `${req.baseUrl || ''}${routePath}` : String(req.originalUrl || req.url || '').split('?')[0];
}

/** @param {import('express').Request} req */
function clientIp(req) {
  return text(req.ip || req.socket?.remoteAddress || '', 80);
}

/** Records the outcome of an HTTP request when it failed, was slow, or a change was abandoned.
 * Successful changes are recorded by the existing application audit; successful reads are not recorded.
 * @param {import('express').Request} req @param {import('express').Response} res
 * @param {{requestId: string, durationMs: number | null, aborted: boolean, slowRequestMs: number,
 *  skip: (req: import('express').Request) => boolean,
 *  applicationAudited: (req: import('express').Request) => boolean}} options */
function recordRequestOutcome(req, res, { requestId, durationMs, aborted, slowRequestMs, skip, applicationAudited }) {
  if (req.get('x-mbbs-rollback-test') === '1' || skip(req)) return;
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const isApi = path.startsWith('/api/');
  const mutating = MUTATING_METHODS.has(req.method);
  const status = aborted ? null : res.statusCode;
  const failed = status !== null && status >= 400;
  const slow = (durationMs || 0) >= slowRequestMs;
  // Change requests covered by the application audit already record success, failure and disconnects.
  const covered = applicationAudited(req);
  let action = null;
  if (aborted) action = mutating && !covered ? 'request.aborted' : null;
  else if (failed && !covered && (isApi || /** @type {number} */ (status) >= 500)) action = 'request.failed';
  else if (slow && isApi) action = 'request.slow';
  if (!action) return;
  const severity = status !== null && status >= 500 ? 'error' : 'warning';
  const route = auditRoute(req);
  const auditError = res.locals.auditError || {};
  const actorKey = req.operator?.id || req.driver?.login || clientIp(req);
  recordLimited(`req|${req.method}|${route}|${status}|${actorKey}`, 10, {
    category: 'request',
    severity,
    source: path.split('/').filter(Boolean)[isApi ? 1 : 0] || 'web',
    action,
    outcome: aborted ? 'client_disconnected' : failed ? 'failed' : 'completed',
    requestId,
    method: req.method,
    route,
    statusCode: status ?? undefined,
    durationMs: durationMs ?? undefined,
    message: auditError.message || (aborted ? 'The client disconnected before the response was sent.'
      : failed ? `HTTP ${status}` : `Took ${Math.round((durationMs || 0) / 1000)}s`),
    errorCode: auditError.code || undefined,
    details: {
      path,
      query: req.query || {},
      params: req.params || {},
      ip: clientIp(req),
      userAgent: text(req.get('user-agent') || '', 300),
      ...(auditError.name ? { errorName: auditError.name } : {}),
      ...(auditError.stack ? { stack: auditError.stack } : {})
    }
  });
}

/** First middleware: assigns a request id, times the request, captures the error message of
 * failed JSON responses, and makes the request visible to audit writers via AsyncLocalStorage.
 * @param {{slowRequestMs?: number, skip?: (req: import('express').Request) => boolean,
 *  applicationAudited?: (req: import('express').Request) => boolean}} [options]
 * @returns {import('express').RequestHandler} */
export function createSystemAuditRequestMiddleware({ slowRequestMs = 20_000, skip = () => false,
  applicationAudited = () => false } = {}) {
  return function systemAuditRequest(req, res, next) {
    const supplied = String(req.get('x-request-id') || '');
    const requestId = /^[A-Za-z0-9_.:-]{8,100}$/u.test(supplied) ? supplied : crypto.randomUUID();
    res.locals.auditRequestId = requestId;
    res.locals.auditStartedAt = process.hrtime.bigint();
    try { res.setHeader('X-Request-Id', requestId); } catch { /* headers may already be sent */ }
    const json = res.json;
    res.json = function auditedJson(body) {
      if (res.statusCode >= 400 && !res.locals.auditError && body && typeof body === 'object') {
        const message = body.error?.message ?? body.error ?? body.message ?? '';
        res.locals.auditError = {
          message: text(typeof message === 'string' ? message : JSON.stringify(message), 4000),
          code: text(body.code || body.error?.code || '', 160)
        };
      }
      return json.call(this, body);
    };
    let settled = false;
    const settle = (/** @type {boolean} */ aborted) => {
      if (settled) return;
      settled = true;
      try {
        recordRequestOutcome(req, res, {
          requestId, durationMs: requestDurationMs(res), aborted, slowRequestMs, skip, applicationAudited
        });
      } catch (error) {
        reportInternalFailure('request outcome could not be recorded', error);
      }
    };
    res.once('finish', () => settle(false));
    res.once('close', () => settle(!res.writableFinished));
    runWithAuditRequest({ requestId, req }, next);
  };
}

/** @param {unknown[]} args */
function consoleMessage(args) {
  return util.formatWithOptions({ depth: 4, breakLength: Infinity, maxArrayLength: 25, maxStringLength: 2000 }, ...args);
}

/** @param {'error' | 'warning'} severity @param {unknown[]} args */
function captureConsole(severity, args) {
  if (args.some((arg) => arg && typeof arg === 'object' && recordedErrors.has(arg))) return;
  const error = /** @type {any} */ (args.find((arg) => arg instanceof Error));
  const message = consoleMessage(error ? args.map((arg) => (arg === error ? error.message : arg)) : args).trim();
  if (!message) return;
  const status = Number(error?.status || 0);
  const effective = severity === 'error' && status >= 400 && status < 500 ? 'warning' : severity;
  recordLimited(`console|${effective}|${limiterKey(message)}`, 10, {
    category: 'system',
    severity: effective,
    source: 'process-log',
    action: `system.log.${effective}`,
    message,
    errorCode: error?.code ? String(error.code) : undefined,
    details: error ? {
      errorName: error.name,
      ...(status ? { status } : {}),
      stack: text(error.stack || '', 4000),
      ...(error.cause ? { cause: text(error.cause?.message || error.cause, 1000) } : {})
    } : {}
  });
}

/** Mirrors console.error and console.warn into the audit log (originals still print). console.log/info
 * carry per-call timing telemetry and are deliberately not recorded.
 * @param {{processName?: string}} [options] */
export function installSystemAuditConsoleCapture({ processName } = {}) {
  if (processName) state.processName = text(processName, 60);
  if (state.consoleInstalled) return;
  state.consoleInstalled = true;
  startLimiterSweep();
  for (const [method, severity] of /** @type {const} */ ([['error', 'error'], ['warn', 'warning']])) {
    const original = console[method];
    console[method] = function capturedConsole(...args) {
      original.apply(console, args);
      if (state.capturing || !state.enabled) return;
      state.capturing = true;
      try { captureConsole(severity, args); }
      catch { /* never let auditing break logging */ }
      finally { state.capturing = false; }
    };
  }
}

/** Records crashes synchronously (the process is about to exit), process warnings, and a start event;
 * replays crash records left by the previous run.
 * @param {{processName?: string, crashFile?: URL | string}} [options] */
export function installSystemAuditProcessHooks({ processName, crashFile = CRASH_FILE } = {}) {
  if (processName) state.processName = text(processName, 60);
  if (state.processHooksInstalled) return;
  state.processHooksInstalled = true;
  replayCrashFile(crashFile);
  recordSystemEvent({
    category: 'system',
    severity: 'info',
    source: 'process',
    action: 'system.process.started',
    message: `${state.processName} started (pid ${process.pid}, node ${process.version})`,
    details: { pid: process.pid, node: process.version, host: os.hostname(), release: process.env.MBBS_RELEASE || '' }
  });
  // A monitor observes the crash without changing Node's default exit behaviour.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    const row = buildRow({
      category: 'system',
      severity: 'critical',
      source: 'process',
      action: origin === 'unhandledRejection' ? 'system.process.unhandled_rejection' : 'system.process.crashed',
      message: /** @type {any} */ (error)?.message || String(error),
      errorCode: /** @type {any} */ (error)?.code,
      details: { origin, stack: text(/** @type {any} */ (error)?.stack || '', 4000), pid: process.pid }
    });
    try { fs.appendFileSync(crashFile, `${JSON.stringify(row)}\n`, { mode: 0o600 }); }
    catch (writeError) { reportInternalFailure('crash record could not be saved', writeError); }
  });
  process.on('warning', (warning) => {
    recordLimited(`warning|${warning.name}|${limiterKey(warning.message)}`, 5, {
      category: 'system',
      severity: 'warning',
      source: 'process',
      action: 'system.process.warning',
      message: `${warning.name}: ${warning.message}`,
      errorCode: /** @type {any} */ (warning).code,
      details: { stack: text(warning.stack || '', 2000) }
    });
  });
}

/** @param {URL | string} crashFile */
function replayCrashFile(crashFile) {
  let content = '';
  try { content = fs.readFileSync(crashFile, 'utf8'); }
  catch { return; }
  try { fs.rmSync(crashFile, { force: true }); }
  catch (error) { reportInternalFailure('crash file could not be removed', error); }
  for (const line of content.split('\n').slice(-200)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && CATEGORY_SET.has(row.category)) {
        state.queue.push({ ...row, details: { ...(row.details || {}), replayedAfterRestart: true } });
      }
    } catch { /* skip a torn line */ }
  }
  if (state.queue.length) scheduleFlush();
}

/** @param {any} value @param {number} max */
function boundedString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Receives browser errors (uncaught errors, rejected promises, failed scripts).
 * @param {{resolveActor?: (req: import('express').Request) => Promise<{actorType: string, actorOperatorId?: string | null, actorName?: string} | null>}} [options] */
export function createClientErrorRouter({ resolveActor = async () => null } = {}) {
  const router = express.Router();
  router.post('/', express.json({ limit: '32kb' }), async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const message = boundedString(body.message, 2000).trim();
    if (!message) return res.status(400).json({ error: 'A client error message is required.' });
    let actor = null;
    try { actor = await resolveActor(req); }
    catch { actor = null; }
    const page = boundedString(body.page, 300).split('?')[0];
    const kind = ['error', 'unhandledrejection', 'resource', 'request'].includes(body.kind) ? body.kind : 'error';
    const ip = clientIp(req);
    recordLimited(`client|${ip}|${kind}|${page}|${limiterKey(message)}`, 3, {
      category: 'client',
      severity: kind === 'request' ? 'warning' : 'error',
      source: 'browser',
      action: `client.${kind}`,
      outcome: 'failed',
      actorType: actor?.actorType || 'anonymous',
      actorOperatorId: actor?.actorOperatorId || null,
      actorName: actor?.actorName || '',
      route: page,
      requestId: boundedString(body.requestId, 100) || undefined,
      message,
      details: {
        page,
        file: boundedString(body.source, 300).split('?')[0],
        line: optionalInteger(body.line),
        column: optionalInteger(body.column),
        stack: boundedString(body.stack, 4000),
        online: typeof body.online === 'boolean' ? body.online : null,
        clientTime: boundedString(body.clientTime, 40),
        ip,
        userAgent: text(req.get('user-agent') || '', 300)
      }
    });
    return res.status(204).end();
  });
  return router;
}
