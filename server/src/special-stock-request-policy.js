import { query } from "./db.js";

export const SPECIAL_STOCK_REQUEST_FLAG_KEY = "special_stock_request_workflow";
export const SPECIAL_STOCK_TEST_SKIP_FLAG_KEY = 'special_stock_request_test_skip_orders';

function policyError(message, status = 404, code = "SPECIAL_STOCK_DISABLED") {
  return Object.assign(new Error(message), { status, code });
}

export async function getSpecialStockRequestPolicy({ queryFn = query } = {}) {
  return getFlagPolicy(SPECIAL_STOCK_REQUEST_FLAG_KEY, queryFn);
}

export async function getSpecialStockTestSkipPolicy({ queryFn = query } = {}) {
  return getFlagPolicy(SPECIAL_STOCK_TEST_SKIP_FLAG_KEY, queryFn);
}

async function getFlagPolicy(flagKey, queryFn) {
  const result = await queryFn(
    `SELECT enabled, revision, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = $1
      LIMIT 1`,
    [flagKey]
  );
  const row = result.rows?.[0];
  return {
    enabled: row?.enabled === true,
    revision: row ? Number(row.revision) : null,
    updatedAt: row?.updated_at instanceof Date ? row.updated_at.toISOString() : row?.updated_at ?? null
  };
}

export function assertSpecialStockRemoteOrderAllowed(detail) {
  if (detail?.salesOrderSkipped || detail?.purchaseOrderSkipped) {
    throw policyError('This request contains a skipped test order. NetSuite order actions are unavailable.', 409, 'SPECIAL_TEST_ORDER_REMOTE_BLOCKED');
  }
  return true;
}

export function assertSpecialStockRequestEnabled(policy) {
  if (policy?.enabled === true) return true;
  throw policyError("The Special Item stock-request workflow is not enabled.");
}

function omitRestrictedFields(value) {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(omitRestrictedFields);
  if (!value || typeof value !== "object") return value;
  const {
    vendorDiscountReview: _vendorDiscountReview,
    vendor_discount_review: _vendorDiscountReviewSnake,
    unitPurchaseCost: _unitPurchaseCost,
    unit_purchase_cost: _unitPurchaseCostSnake,
    scmInternalNote: _scmInternalNote,
    scm_internal_note: _scmInternalNoteSnake,
    fulfillmentChangePlan: _fulfillmentChangePlan,
    quantityReviewPlan: _quantityReviewPlan,
    closureReviewPlan: _closureReviewPlan,
    ...visible
  } = value;
  return Object.fromEntries(Object.entries(visible).map(([key, entry]) => [key, omitRestrictedFields(entry)]));
}

export function projectSpecialStockCase(detail, audience = "sales") {
  if (!detail || typeof detail !== "object") return detail;
  if (audience !== 'sales') detail = omitSalesInternalRemark(detail);
  if (audience === "scm" || audience === "admin") {
    return {
      ...detail,
      lines: Array.isArray(detail.lines) ? detail.lines.map((line) => ({ ...line })) : []
    };
  }
  const visible = omitRestrictedFields(detail);
  return {
    ...visible,
    lines: Array.isArray(detail.lines) ? detail.lines.map(omitRestrictedFields) : []
  };
}

// Remove the private value recursively, including any nested audit snapshots.
/** @param {any} value @returns {any} */
function omitSalesInternalRemark(value) {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.filter(entry => entry?.eventType !== 'special_sales_internal_remark_updated').map(omitSalesInternalRemark);
  if (!value || typeof value !== 'object') return value;
  const { salesInternalRemark: _remark, sales_internal_remark: _storedRemark, ...visible } = value;
  return Object.fromEntries(Object.entries(visible).map(([key, entry]) => [key, omitSalesInternalRemark(entry)]));
}
