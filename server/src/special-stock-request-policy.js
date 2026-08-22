import { query } from "./db.js";

export const SPECIAL_STOCK_REQUEST_FLAG_KEY = "special_stock_request_workflow";

function policyError(message, status = 404, code = "SPECIAL_STOCK_DISABLED") {
  return Object.assign(new Error(message), { status, code });
}

export async function getSpecialStockRequestPolicy({ queryFn = query } = {}) {
  const result = await queryFn(
    `SELECT enabled, revision, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = $1
      LIMIT 1`,
    [SPECIAL_STOCK_REQUEST_FLAG_KEY]
  );
  const row = result.rows?.[0];
  return {
    enabled: row?.enabled === true,
    revision: row ? Number(row.revision) : null,
    updatedAt: row?.updated_at instanceof Date ? row.updated_at.toISOString() : row?.updated_at ?? null
  };
}

export function assertSpecialStockRequestEnabled(policy) {
  if (policy?.enabled === true) return true;
  throw policyError("The Special Item stock-request workflow is not enabled.");
}

function omitRestrictedFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    unitPurchaseCost: _unitPurchaseCost,
    unit_purchase_cost: _unitPurchaseCostSnake,
    scmInternalNote: _scmInternalNote,
    scm_internal_note: _scmInternalNoteSnake,
    ...visible
  } = value;
  return visible;
}

export function projectSpecialStockCase(detail, audience = "sales") {
  if (!detail || typeof detail !== "object") return detail;
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
