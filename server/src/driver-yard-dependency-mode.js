// @ts-check

import { query } from "./db.js";

export const DRIVER_YARD_DEPENDENCY_SOFT_MODE_FLAG_KEY = "driver_yard_dependency_soft_mode";

/**
 * This is deliberately independent from Dispatch dependency validation. It
 * controls only whether the Driver PWA may record physical execution while an
 * ordinary yard-replenishment dependency is still unresolved.
 *
 * Missing rows and malformed values fail closed to Hard mode.
 *
 * @param {{queryFn?: typeof query}} [options]
 */
export async function getDriverYardDependencyMode({ queryFn = query } = {}) {
  const result = await queryFn(
    `SELECT enabled, revision, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = $1
      LIMIT 1`,
    [DRIVER_YARD_DEPENDENCY_SOFT_MODE_FLAG_KEY]
  );
  const row = result.rows?.[0];
  if (!row) {
    return { mode: "hard", soft: false, revision: null, updatedAt: null };
  }
  const soft = row.enabled === true;
  return {
    mode: soft ? "soft" : "hard",
    soft,
    revision: Number(row.revision),
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : row.updated_at ?? null
  };
}

/** @param {{block?: Record<string, unknown> | null, softMode?: boolean}} [input] */
export function evaluateDriverYardDependencyStart({ block = null, softMode = false } = {}) {
  const mode = softMode === true ? "soft" : "hard";
  if (!block) return { mode, blocking: null, warnings: [] };
  if (mode === "hard") return { mode, blocking: block, warnings: [] };
  return {
    mode,
    blocking: null,
    warnings: [{
      ...block,
      severity: "warning",
      softened: true,
      message: `Soft testing mode: ${String(block.message || "The required yard-replenishment Transfer Order is not complete.")}`
    }]
  };
}

/** @param {{conflicts?: Record<string, unknown>[], softMode?: boolean}} [input] */
export function evaluateDriverYardDependencyCompletion({ conflicts = [], softMode = false } = {}) {
  const mode = softMode === true ? "soft" : "hard";
  if (!conflicts.length) return { mode, blocking: [], warnings: [] };
  if (mode === "hard") return { mode, blocking: conflicts, warnings: [] };
  return {
    mode,
    blocking: [],
    warnings: conflicts.map((conflict) => ({
      ...conflict,
      code: "YARD_DEPENDENCY_DELIVERY_REVIEW_REQUIRED",
      severity: "warning",
      softened: true,
      message: `Soft testing mode: ${String(
        conflict.transferOrderRef || "Transfer Order"
      )} still needs dependency review (${String(
        conflict.reason || "yard_dependency_delivery_not_applied"
      )}).`
    }))
  };
}
