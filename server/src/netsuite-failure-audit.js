// @ts-check
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

/** @param {unknown} value @param {number} [limit] */
export function sanitizeNetSuiteFailureText(value, limit = 4000) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/giu, '[private key omitted]')
    .replace(/data:[^\s,]*,[^\s"'<>]+/giu, '[image omitted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>;,]+/giu, '[authorization omitted]')
    .replace(/(["']?\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|api[_-]?key|token|secret|signature|client_assertion)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,}]+)/giu, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[token omitted]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, valueUrl => {
      try { const url = new URL(valueUrl); return `${url.protocol}//${url.host}${url.pathname}`; }
      catch { return '[URL omitted]'; }
    })
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .slice(0, limit);
}

const textFields = ['actorOperatorId', 'auditRequestId', 'requestId', 'commandId', 'orderId', 'orderRef', 'orderType', 'functionKey',
  'transactionType', 'sourceOrderKind', 'sourceNetSuiteId', 'stage', 'operation', 'clientVersion', 'errorName', 'requestPath'];
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;

/** @param {Record<string, any>} metadata @param {any} error */
function diagnostic(metadata, error) {
  const row = /** @type {Record<string, any>} */ ({
    failureId: uuid.test(metadata.failureId) ? metadata.failureId.toLowerCase() : crypto.randomUUID(),
    occurredAt: Number.isFinite(Date.parse(metadata.occurredAt)) ? new Date(metadata.occurredAt).toISOString() : new Date().toISOString(),
    clientReported: metadata.clientReported === true,
    errorMessage: sanitizeNetSuiteFailureText(error?.message || error || 'NetSuite operation failed.'),
    errorCode: sanitizeNetSuiteFailureText(error?.code || error?.payload?.code || 'REQUEST_FAILED', 160),
    errorName: sanitizeNetSuiteFailureText(error?.name || 'Error', 80),
    stack: sanitizeNetSuiteFailureText(error?.stack || '', 4000)
  });
  for (const key of textFields) {
    if (metadata[key] !== undefined && metadata[key] !== null) { row[key] = sanitizeNetSuiteFailureText(metadata[key], 180); }
  }
  for (const key of ['locationId', 'attempt', 'stepIndex']) {
    if (Number.isSafeInteger(Number(metadata[key])) && Number(metadata[key]) > 0) { row[key] = Number(metadata[key]); }
  }
  const status = Number(metadata.httpStatus ?? error?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) { row.httpStatus = status; }
  if (typeof metadata.browserOnline === 'boolean') { row.browserOnline = metadata.browserOnline; }
  if (typeof metadata.method === 'string') { row.method = sanitizeNetSuiteFailureText(metadata.method, 12).toUpperCase(); }
  if (metadata.path) {
    try { row.path = sanitizeNetSuiteFailureText(new URL(String(metadata.path), 'https://netsuite.invalid').pathname, 300); }
    catch { row.path = '[invalid path]'; }
  }
  const sourceId = row.path?.match(/\/record\/v1\/(?:purchaseorder|salesorder|transferorder)\/(\d+)/iu)?.[1];
  row.sourceNetSuiteId ||= sourceId || '';
  row.requestId ||= row.commandId || row.failureId;
  row.orderId ||= row.sourceNetSuiteId || '';
  row.orderRef ||= sanitizeNetSuiteFailureText(metadata.sourceOrderRef || '', 180);
  if (error?.cause) {
    row.cause = sanitizeNetSuiteFailureText(error.cause.message || error.cause, 1000);
    row.causeCode = sanitizeNetSuiteFailureText(error.cause.code || '', 160);
  }
  return row;
}

/** @param {unknown} text */
function decoded(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) { return null; }
  try { const value = JSON.parse(text); return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { return null; }
}

/** @param {{persist: (row: Record<string, any>) => Promise<unknown>, fallback?: (row: Record<string, any>) => Promise<unknown>, emergency?: (row: Record<string, any>) => void}} options */
export function createNetSuiteFailureAudit({ persist, fallback = async row => console.error(JSON.stringify(row)), emergency = row => console.error(JSON.stringify(row)) }) {
  const storage = new AsyncLocalStorage();
  /** @template T @param {Record<string, any>} details @param {() => T} work @returns {T} */
  function context(details, work) { return storage.run({ ...storage.getStore(), ...details }, work); }
  /** @param {unknown} error @param {Record<string, any>} [details] */
  async function record(error, details = {}) {
    const current = storage.getStore();
    const requestDetails = typeof current?.requestContext === 'function' ? current.requestContext() : {};
    const row = diagnostic({ ...requestDetails, ...current, ...details }, error);
    try { await persist(row); return { failureId: row.failureId, persisted: true }; }
    catch (storageError) {
      const failed = { event: 'netsuite_failure_fallback', ...row, persistenceError: sanitizeNetSuiteFailureText(storageError instanceof Error ? storageError.message : storageError, 500) };
      try { await fallback(failed); }
      catch (fallbackError) {
        try { emergency({ ...failed, fallbackError: sanitizeNetSuiteFailureText(fallbackError instanceof Error ? fallbackError.message : fallbackError, 500) }); }
        catch { /* Preserve the original operation even if every diagnostic sink fails. */ }
      }
      return { failureId: row.failureId, persisted: false };
    }
  }
  /** @template T @param {Record<string, any>} details @param {() => Promise<T>} work @returns {Promise<T>} */
  function capture(details, work) {
    return context(details, async () => {
      try { return await work(); }
      catch (error) { await record(error); throw error; }
    });
  }
  /** @param {{response: {ok: boolean, status: number}, text: string}} result @param {Record<string, any>} [details] */
  async function response(result, details = {}) {
    const data = decoded(result.text);
    if (result.response.ok && data?.ok !== false && data?.success !== false) { return; }
    const first = Array.isArray(data?.['o:errorDetails']) ? data['o:errorDetails'][0] : null;
    const error = { code: data?.code || first?.['o:errorCode'] || `NETSUITE_HTTP_${result.response.status}`,
      message: data?.message || data?.error?.message || data?.error || first?.detail || `NetSuite HTTP ${result.response.status}: ${result.text}` };
    await record(error, { ...details, httpStatus: result.response.status, ...(data?.stage ? { stage: data.stage } : {}) });
  }
  /** The merged diagnostic context of the current operation (actor, request, order, command). */
  function snapshot() {
    const current = storage.getStore();
    if (!current) { return {}; }
    const { requestContext, ...details } = current;
    return { ...(typeof requestContext === 'function' ? requestContext() : {}), ...details };
  }
  return { context, record, capture, response, snapshot };
}
