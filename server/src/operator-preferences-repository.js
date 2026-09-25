import { query } from "./db.js";
import { normalizeOperatorPreferences } from "./operator-preferences-policy.js";

export async function getOperatorPreferences(operatorId) {
  const result = await query("SELECT preferences FROM operator_ui_preferences WHERE operator_id = $1", [operatorId]);
  return normalizeOperatorPreferences(result.rows[0]?.preferences);
}

export async function putOperatorPreferences(operatorId, input) {
  const preferences = normalizeOperatorPreferences(input);
  const result = await query(`INSERT INTO operator_ui_preferences (operator_id, preferences)
    VALUES ($1, $2::jsonb) ON CONFLICT (operator_id) DO UPDATE
    SET preferences = EXCLUDED.preferences, updated_at = now() RETURNING preferences`,
  [operatorId, JSON.stringify(preferences)]);
  return result.rows[0].preferences;
}
