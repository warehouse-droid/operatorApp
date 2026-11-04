// @ts-check
// Automatic retry rules for IF/IR posting. Only timeouts and lost connections
// are retried; every other failure (NetSuite rejections, quantity or identity
// mismatches, validation) keeps waiting for a person in Admin.

/** Minutes to wait before automatic retry 1, 2, 3, ... */
export const POSTING_AUTO_RETRY_DELAYS_MINUTES = Object.freeze([1, 5, 15, 30, 60]);
export const POSTING_AUTO_RETRY_LIMIT = POSTING_AUTO_RETRY_DELAYS_MINUTES.length;

// PostgreSQL: lock timeout, statement timeout, server shutdown/restart, connection failures.
const DATABASE_CODES = new Set(['55P03', '57014', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006']);
// Node/undici transport failures and the app's own NetSuite request timeout.
const TRANSPORT_CODES = new Set(['NETSUITE_REQUEST_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);
// HTTP request timeout and gateway timeout.
const TIMEOUT_STATUSES = new Set([408, 504]);
const MESSAGES = [
  /canceling statement due to (?:lock|statement) timeout/i,
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /terminating connection due to administrator command/i,
  /the database system is (?:starting up|shutting down)/i,
  /socket hang up/i,
  /^fetch failed$/i,
  /NetSuite request timed out/i
];

/** @param {unknown} error @returns {Record<string, any>[]} */
function errorChain(error) {
  /** @type {Record<string, any>[]} */
  const chain = [];
  let current = /** @type {any} */ (error);
  while (current && typeof current === 'object' && chain.length < 6 && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

/**
 * True only for a timeout or a lost connection (database or NetSuite).
 * @param {unknown} error
 */
export function isPostingTimeoutOrConnectionFailure(error) {
  return errorChain(error).some(value => {
    const code = String(value.code ?? '').toUpperCase();
    if (DATABASE_CODES.has(code) || TRANSPORT_CODES.has(code)) {return true;}
    if (value.name === 'AbortError' || value.name === 'TimeoutError') {return true;}
    if (TIMEOUT_STATUSES.has(Number(value.status))) {return true;}
    const message = String(value.message ?? '');
    return MESSAGES.some(pattern => pattern.test(message));
  });
}

/**
 * Minutes until the next automatic retry, or null once the limit is used.
 * @param {number} completedAutoRetries
 */
export function postingAutoRetryDelayMinutes(completedAutoRetries) {
  const index = Number(completedAutoRetries);
  if (!Number.isSafeInteger(index) || index < 0 || index >= POSTING_AUTO_RETRY_LIMIT) {return null;}
  return POSTING_AUTO_RETRY_DELAYS_MINUTES[index];
}
