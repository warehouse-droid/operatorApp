import { query } from "./db.js";

export const SCM_SCHEDULE_PREFERENCE_SURFACES = Object.freeze(["scm", "dispatch", "sales"]);
export const SCM_SCHEDULE_PREFERENCE_KINDS = Object.freeze(["PO", "Sp.O", "TO", "VRMA"]);
export const SCM_SCHEDULE_PREFERENCE_METHODS = Object.freeze(["MBT", "Vendor", "Customer Pickup"]);
export const SCM_SCHEDULE_PREFERENCE_STATUSES = Object.freeze([
  "Queued",
  "Planned",
  "Partially Done",
  "In Transit",
  "Completed",
  "Reconcile Review",
  "Urgent",
  "Cancelled",
  "Hold",
  "Priority",
  "Surplus Only",
  "Book Appt"
]);

const kindSet = new Set(SCM_SCHEDULE_PREFERENCE_KINDS);
const methodSet = new Set(SCM_SCHEDULE_PREFERENCE_METHODS);
const statusSet = new Set(SCM_SCHEDULE_PREFERENCE_STATUSES);
const surfaceSet = new Set(SCM_SCHEDULE_PREFERENCE_SURFACES);

function preferenceError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function requiredOperatorId(value) {
  const operatorId = String(value || "").trim();
  if (!operatorId) throw preferenceError("A signed-in staff account is required.", 401);
  return operatorId;
}

export function normalizeScmSchedulePreferenceSurface(value) {
  const surface = String(value || "").trim().toLowerCase();
  if (!surfaceSet.has(surface)) {
    throw preferenceError("Schedule preference surface must be scm, dispatch, or sales.");
  }
  return surface;
}

function allowlistedValue(value, allowed, label, { uppercase = false } = {}) {
  let clean = String(value || "").trim();
  if (uppercase) clean = clean.toUpperCase();
  if (!clean) return "";
  if (!allowed.has(clean)) throw preferenceError(`Invalid PO/TO Schedule ${label}: ${clean}.`);
  return clean;
}

function allowlistedKind(value) {
  const raw = String(value || "").trim().toUpperCase();
  const clean = raw === "SP.O" ? "Sp.O" : raw;
  if (!clean) return "";
  if (!kindSet.has(clean)) throw preferenceError(`Invalid PO/TO Schedule Type: ${clean}.`);
  return clean;
}

function allowlistedStatuses(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const statuses = [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
  const invalid = statuses.find((status) => !statusSet.has(status));
  if (invalid) throw preferenceError(`Invalid PO/TO Schedule status: ${invalid}.`);
  return statuses;
}

export function normalizeScmSchedulePreference(patch = {}, { surface } = {}) {
  const normalizedSurface = normalizeScmSchedulePreferenceSurface(surface ?? patch.surface);
  const scmSurface = normalizedSurface === "scm";
  const typeFilterSurface = scmSurface || normalizedSurface === "dispatch";
  return {
    surface: normalizedSurface,
    kind: typeFilterSurface
      ? allowlistedKind(patch.kind ?? patch.orderKind)
      : "",
    method: scmSurface
      ? allowlistedValue(patch.method, methodSet, "Method")
      : "",
    status: allowlistedStatuses(patch.status ?? patch.statuses)
  };
}

function publicPreference(row, surface) {
  if (!row) {
    return {
      surface,
      kind: "",
      method: "",
      status: [],
      persisted: false
    };
  }
  return {
    surface: row.surface,
    kind: row.order_kind || "",
    method: row.method || "",
    status: Array.isArray(row.statuses) ? row.statuses : [],
    persisted: true,
    updatedAt: row.updated_at || null
  };
}

export async function getScmSchedulePreference(operatorId, surfaceValue) {
  const id = requiredOperatorId(operatorId);
  const surface = normalizeScmSchedulePreferenceSurface(surfaceValue);
  const result = await query(
    `SELECT surface, order_kind, method, statuses, updated_at
       FROM scm_schedule_user_preferences
      WHERE operator_id = $1
        AND surface = $2`,
    [id, surface]
  );
  return publicPreference(result.rows[0], surface);
}

export async function updateScmSchedulePreference(operatorId, surfaceValue, patch = {}) {
  const id = requiredOperatorId(operatorId);
  const preference = normalizeScmSchedulePreference(patch, { surface: surfaceValue });
  const result = await query(
    `INSERT INTO scm_schedule_user_preferences (
       operator_id, surface, order_kind, method, statuses, updated_at
     ) VALUES ($1, $2, $3, $4, $5::text[], now())
     ON CONFLICT (operator_id, surface) DO UPDATE SET
       order_kind = EXCLUDED.order_kind,
       method = EXCLUDED.method,
       statuses = EXCLUDED.statuses,
       updated_at = now()
     RETURNING surface, order_kind, method, statuses, updated_at`,
    [id, preference.surface, preference.kind, preference.method, preference.status]
  );
  return publicPreference(result.rows[0], preference.surface);
}
