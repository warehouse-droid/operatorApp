// @ts-check
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';
import { createNetSuiteFailureAudit } from './netsuite-failure-audit.js';

// A separate, bounded pool keeps diagnostics outside the business transaction and
// prevents a saturated posting pool from blocking its own failure evidence.
const auditPool = new pg.Pool({ connectionString: config.databaseUrl, max: 2,
  connectionTimeoutMillis: 2000, statement_timeout: 3000, idleTimeoutMillis: 10000, allowExitOnIdle: true });
auditPool.on('error', error => console.error('NetSuite diagnostic database connection failed:', 'code' in error ? error.code : 'DATABASE_ERROR'));

/** @param {Record<string, any>} row */
export async function persistNetSuiteFailure(row) {
  const orderId = /^-?\d{1,15}$/u.test(String(row.orderId || row.sourceNetSuiteId || '')) ? String(row.orderId || row.sourceNetSuiteId) : null;
  await auditPool.query(`WITH receipt AS (
    INSERT INTO netsuite_failure_receipts(actor_key,failure_id) VALUES($1,$2::uuid)
    ON CONFLICT DO NOTHING RETURNING failure_id
  ) INSERT INTO delivery_audit_log(actor_type,actor_operator_id,source,action,order_id,details)
    SELECT $3,(SELECT id FROM operators WHERE id=$4),'netsuite-diagnostics','netsuite.attempt.failed',$5,$6::jsonb FROM receipt`,
  [row.actorOperatorId || '', row.failureId, row.actorOperatorId ? 'operator' : 'system', row.actorOperatorId || null, orderId, JSON.stringify(row)]);
}

/** @param {Record<string, any>} row @param {URL | string} [file] */
export async function appendNetSuiteFailureFallback(row, file = new URL('../data/netsuite-failures.ndjson', import.meta.url)) {
  const handle = await fs.open(file, 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify(row)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  console.error(JSON.stringify(row));
}

export const netSuiteFailureAudit = createNetSuiteFailureAudit({ persist: persistNetSuiteFailure, fallback: appendNetSuiteFailureFallback });
export function closeNetSuiteFailureAudit() { return auditPool.end(); }

/** @type {import('express').RequestHandler} */
export function netSuiteFailureRequestContext(req, res, next) {
  const requestId = crypto.randomUUID();
  return netSuiteFailureAudit.context({ requestContext: () => ({
    actorOperatorId: (/** @type {any} */ (req)).operator?.id,
    auditRequestId: res.locals?.auditRequestId,
    requestId: req.body?.requestId || requestId,
    orderId: req.params?.id || req.body?.orderId || req.originalUrl.match(/\/orders\/([^/?]+)/u)?.[1],
    locationId: req.body?.destinationLocationId ?? req.body?.locationId,
    requestPath: req.originalUrl.split('?')[0]
  }) }, next);
}
