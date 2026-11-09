// @ts-check
// Records every successful NetSuite write (record create/transform/update/delete and RESTlet
// calls) in the system audit log. Failed writes are already recorded by the NetSuite failure
// audit (action netsuite.attempt.failed), so they are not repeated here.
import { recordSystemEvent } from './system-audit.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Describes a NetSuite HTTP call, or returns null when it is a read (SuiteQL, GET, token exchange).
 * @param {string | URL} url @param {string} [method] */
export function classifyNetSuiteWrite(url, method = 'GET') {
  const verb = String(method || 'GET').toUpperCase();
  if (READ_METHODS.has(verb)) return null;
  let target;
  try { target = new URL(String(url)); }
  catch { return null; }
  const path = target.pathname;
  if (/\/query\/v1\/suiteql\/?$/iu.test(path) || /\/oauth2\//iu.test(path)) return null;
  if (/\/app\/site\/hosting\/restlet\.nl$/iu.test(path)) {
    return {
      kind: 'restlet',
      action: 'netsuite.restlet.called',
      script: target.searchParams.get('script') || '',
      deploy: target.searchParams.get('deploy') || '',
      path
    };
  }
  const record = path.match(/\/record\/v1\/([^/]+)(?:\/([^/!]+))?(?:\/!transform\/([^/]+))?\/?$/iu);
  if (!record) return { kind: 'other', action: `netsuite.${verb.toLowerCase()}`, path };
  const [, recordType, recordId = '', transformTarget = ''] = record;
  if (transformTarget) {
    return {
      kind: 'transform',
      action: `netsuite.${transformTarget.toLowerCase()}.created`,
      recordType: transformTarget,
      sourceRecordType: recordType,
      sourceRecordId: recordId,
      path
    };
  }
  const operation = verb === 'POST' && !recordId ? 'created'
    : verb === 'DELETE' ? 'deleted'
      : 'updated';
  return { kind: 'record', action: `netsuite.${recordType.toLowerCase()}.${operation}`, recordType, recordId, path };
}

/** @param {unknown} value */
function parsedJson(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string' || !value.trim() || value.length > 512 * 1024) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  } catch {
    return null;
  }
}

/** @param {any} payload */
function logicalFailure(payload) {
  return Boolean(payload && typeof payload === 'object' && (payload.ok === false || payload.success === false));
}

/** @param {NonNullable<ReturnType<typeof classifyNetSuiteWrite>>} write @param {string} createdId @param {number} status */
function describeWrite(write, createdId, status) {
  if (write.kind === 'restlet') return `NetSuite RESTlet script ${write.script || '?'} succeeded (HTTP ${status})`;
  if (write.kind === 'transform') {
    return `Created ${write.recordType}${createdId ? ` ${createdId}` : ''} from ${write.sourceRecordType} ${write.sourceRecordId}`;
  }
  if (write.kind === 'record') {
    const verb = write.action.endsWith('.created') ? 'Created' : write.action.endsWith('.deleted') ? 'Deleted' : 'Updated';
    const id = createdId || write.recordId;
    return `${verb} ${write.recordType}${id ? ` ${id}` : ''}`;
  }
  return `NetSuite ${write.path} succeeded (HTTP ${status})`;
}

/** Builds the audit event for a NetSuite write, or null if nothing should be recorded.
 * @param {{url: string | URL, method?: string, status: number, ok: boolean, location?: string,
 *  requestBody?: unknown, responseValue?: unknown, durationMs?: number, attempt?: number,
 *  context?: Record<string, any>}} call */
export function netSuiteWriteAuditEvent(call) {
  const write = classifyNetSuiteWrite(call.url, call.method);
  if (!write || !call.ok) return null;
  const response = parsedJson(call.responseValue);
  if (logicalFailure(response)) return null;
  const context = call.context || {};
  const createdId = String(call.location || '').match(/\/(\d+)\/?$/u)?.[1] || '';
  const message = describeWrite(write, createdId, call.status);
  return {
    category: 'netsuite',
    severity: 'info',
    source: 'netsuite',
    action: write.action,
    outcome: 'posted',
    actorOperatorId: context.actorOperatorId || null,
    ...(context.actorOperatorId ? { actorType: 'operator' } : {}),
    method: String(call.method || '').toUpperCase(),
    route: write.path,
    statusCode: call.status,
    durationMs: call.durationMs,
    orderRef: context.orderRef || context.sourceOrderRef || undefined,
    message: `${message} (${Math.round(Number(call.durationMs || 0))} ms)`,
    details: {
      ...write,
      createdRecordId: createdId || null,
      attempt: call.attempt || 1,
      operation: context.operation || '',
      functionKey: context.functionKey || '',
      commandId: context.commandId || '',
      commandRequestId: context.requestId || '',
      transactionType: context.transactionType || '',
      sourceOrderKind: context.sourceOrderKind || '',
      sourceNetSuiteId: context.sourceNetSuiteId || context.orderId || '',
      locationId: context.locationId || null,
      requestPath: context.requestPath || '',
      payload: parsedJson(call.requestBody),
      response
    }
  };
}

/** Records a NetSuite write if it is one; never throws.
 * @param {Parameters<typeof netSuiteWriteAuditEvent>[0]} call */
export function auditNetSuiteWrite(call) {
  try {
    const event = netSuiteWriteAuditEvent(call);
    if (event) recordSystemEvent(event);
  } catch {
    // Posting must never fail because its audit record could not be built.
  }
}
