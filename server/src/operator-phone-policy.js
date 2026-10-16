// @ts-check
import { query } from "./db.js";

export const OPERATOR_PHONE_LAYOUT_FLAG_KEY = "operator_phone_layout";

/** @param {Record<string, unknown> | null | undefined} row */
export function materializeOperatorPhonePolicy(row) {
  const revision = Number(row?.revision);
  return {
    flagKey: OPERATOR_PHONE_LAYOUT_FLAG_KEY,
    enabled: row?.enabled === true,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : null
  };
}

export async function getOperatorPhonePolicy({ queryFn = query } = {}) {
  const result = await queryFn(
    "SELECT enabled, revision FROM mbt_feature_flags WHERE flag_key = $1 LIMIT 1",
    [OPERATOR_PHONE_LAYOUT_FLAG_KEY]
  );
  return materializeOperatorPhonePolicy(result.rows?.[0]);
}
