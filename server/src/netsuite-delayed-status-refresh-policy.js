export const DELAYED_STATUS_REFRESH_INITIAL_DELAY_MS = 10_000;
export const DELAYED_STATUS_REFRESH_MAX_ATTEMPTS = 8;
export const DELAYED_STATUS_REFRESH_RETRY_DELAYS_MS = Object.freeze([
  30_000,
  120_000,
  600_000,
  1_800_000,
  7_200_000,
  21_600_000,
  43_200_000
]);
export const DELAYED_STATUS_REFRESH_POLL_INTERVAL_MS = 5_000;
export const DELAYED_STATUS_REFRESH_LEASE_MS = 120_000;
export const DELAYED_STATUS_REFRESH_BATCH_SIZE = 10;

const SUPPORTED_ORDER_TYPES = new Set(["sales_order", "purchase_order"]);

function normalizedStatusCode(row = {}) {
  return String(row.status ?? "").trim().toUpperCase();
}

function normalizedStatusText(row = {}) {
  return String(row.statusText ?? row.status_text ?? "")
    .replace(/^(?:sales|purchase)\s+order\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDelayedStatusRefreshIdentity(input = {}) {
  const orderType = String(input.orderType || "").trim().toLowerCase();
  const netsuiteOrderId = Number(input.netsuiteOrderId);
  if (!SUPPORTED_ORDER_TYPES.has(orderType)) {
    throw new TypeError("Delayed status refresh requires a supported order type.");
  }
  if (!Number.isSafeInteger(netsuiteOrderId) || netsuiteOrderId <= 0) {
    throw new TypeError("Delayed status refresh requires a positive integer NetSuite order ID.");
  }
  return {
    orderType,
    netsuiteOrderId,
    tranid: String(input.tranid || "").trim()
  };
}

export function isDelayedStatusPendingApproval(row = {}) {
  return normalizedStatusCode(row) === "A"
    || /^pending(?: supervisor)? approval$/i.test(normalizedStatusText(row));
}

export function delayedStatusRefreshRetryDelayMs(attemptNumber) {
  const attempt = Number(attemptNumber);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError("Delayed status refresh attempt number must be a positive integer.");
  }
  return DELAYED_STATUS_REFRESH_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

function retryDecision(attemptNumber, reason) {
  const retryDelayMs = delayedStatusRefreshRetryDelayMs(attemptNumber);
  return retryDelayMs === null
    ? { outcome: "failed", reason, retryDelayMs: null }
    : { outcome: "retry", reason, retryDelayMs };
}

function salesOrderAllocationRequiresRetry(input = {}) {
  if (Number(input.attemptNumber) !== 1) {
    return false;
  }
  return Boolean(input.allocationRefreshError)
    || Number(input.allocationRefresh?.unsettledLineCount || 0) > 0;
}

export function delayedStatusRefreshDecision(input = {}) {
  if (input.error) {
    return retryDecision(input.attemptNumber, "transient_error");
  }
  if (!input.remoteStatus) {
    return retryDecision(input.attemptNumber, "missing_status");
  }
  if (isDelayedStatusPendingApproval(input.remoteStatus)) {
    return retryDecision(input.attemptNumber, "pending_approval");
  }
  if (salesOrderAllocationRequiresRetry(input)) {
    return retryDecision(input.attemptNumber, "sales_order_allocations_unsettled");
  }
  return { outcome: "succeeded", reason: "status_refreshed", retryDelayMs: null };
}
