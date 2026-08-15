// @ts-check

import { query } from "./db.js";

export const OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY =
  "operator_customer_pickup_photo_required";
export const OPERATOR_CUSTOMER_PICKUP_REQUIRED_PHOTO_COUNT = 1;

/** @param {unknown} value */
function normalizedRevision(value) {
  try {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function normalizedUpdatedAt(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === "string" && value.trim() ? value : null;
}

/** @param {Record<string, unknown> | null | undefined} row */
export function materializeOperatorCustomerPickupPhotoRequirement(row) {
  const required = row?.enabled !== false;
  return {
    flagKey: OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY,
    required,
    requiredPhotoCount: required ? OPERATOR_CUSTOMER_PICKUP_REQUIRED_PHOTO_COUNT : 0,
    revision: normalizedRevision(row?.revision),
    updatedAt: normalizedUpdatedAt(row?.updated_at)
  };
}

export async function getOperatorCustomerPickupPhotoRequirement({ queryFn = query } = {}) {
  const result = await queryFn(
    `SELECT enabled, revision, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = $1
      LIMIT 1`,
    [OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY]
  );
  return materializeOperatorCustomerPickupPhotoRequirement(result.rows?.[0]);
}
