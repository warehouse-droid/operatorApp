import { query } from "./db.js";
import { SCM_SCHEDULE_PREFERENCE_KINDS, SCM_SCHEDULE_PREFERENCE_STATUSES } from "./scm-schedule-preference-repository.js";

export const SCM_SCHEDULE_COLOR_PRESETS = Object.freeze([
  { id: "deep-red", label: "Deep red / White", background: "#991b1b", color: "#ffffff" },
  { id: "navy", label: "Navy / White", background: "#1e3a5f", color: "#ffffff" },
  { id: "forest", label: "Forest green / White", background: "#166534", color: "#ffffff" },
  { id: "purple", label: "Purple / White", background: "#6b21a8", color: "#ffffff" },
  { id: "blue", label: "Blue / White", background: "#1d4ed8", color: "#ffffff" },
  { id: "amber", label: "Amber / Dark", background: "#facc15", color: "#422006" },
  { id: "pale-yellow", label: "Pale yellow / Dark", background: "#fff4b8", color: "#20313a" },
  { id: "light-grey", label: "Light grey / Dark", background: "#edf2f4", color: "#54636c" }
]);
export const SCM_SCHEDULE_FORMATTING_TYPES = Object.freeze([
  ...SCM_SCHEDULE_PREFERENCE_KINDS.filter((type) => type !== "Sp.O"),
  "Sp.O"
]);

const DEFAULT_BACKGROUND = "#ffffff";
const DEFAULT_COLOR = "#20313a";
const colorPattern = /^#[0-9a-f]{6}$/i;
const statusSet = new Set(SCM_SCHEDULE_PREFERENCE_STATUSES);
const typeSet = new Set(SCM_SCHEDULE_FORMATTING_TYPES);

const defaultStatusRows = Object.freeze({
  Urgent: { background: "#fff4f4", color: DEFAULT_COLOR },
  Priority: { background: "#fff4f4", color: DEFAULT_COLOR },
  "Surplus Only": { background: "#f6f8fb", color: DEFAULT_COLOR },
  Planned: { background: "#fff4b8", color: DEFAULT_COLOR },
  Completed: { background: "#edf2f4", color: "#54636c" },
  "Reconcile Review": { background: "#fff8e7", color: "#4e3900" }
});

function formattingError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || /^(1|true|yes|on)$/i.test(String(value).trim());
}

function colorValue(value, fallback, label) {
  const clean = String(value ?? fallback ?? "").trim().toLowerCase();
  if (!colorPattern.test(clean)) {
    throw formattingError(`${label} must be a six-digit hex color such as #991b1b.`);
  }
  return clean;
}

function defaultRule({ row = null } = {}) {
  return {
    cellEnabled: false,
    cellBackground: DEFAULT_BACKGROUND,
    cellColor: DEFAULT_COLOR,
    rowEnabled: Boolean(row),
    rowBackground: row?.background || DEFAULT_BACKGROUND,
    rowColor: row?.color || DEFAULT_COLOR
  };
}

function normalizeRule(value = {}, fallback = defaultRule(), { allowRow = false, label = "Formatting" } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    cellEnabled: booleanValue(source.cellEnabled, fallback.cellEnabled),
    cellBackground: colorValue(source.cellBackground, fallback.cellBackground, `${label} cell background`),
    cellColor: colorValue(source.cellColor, fallback.cellColor, `${label} cell font color`),
    rowEnabled: allowRow ? booleanValue(source.rowEnabled, fallback.rowEnabled) : false,
    rowBackground: colorValue(source.rowBackground, fallback.rowBackground, `${label} row background`),
    rowColor: colorValue(source.rowColor, fallback.rowColor, `${label} row font color`)
  };
}

function cleanDropoffKey(value) {
  const key = String(value || "").replace(/\s+/g, " ").trim();
  if (!key || key.length > 120) {
    throw formattingError("Each Drop-off Point formatting key must be between 1 and 120 characters.");
  }
  return key;
}

function sourceRules(value = {}) {
  const source = value?.rules && typeof value.rules === "object" ? value.rules : value;
  return source && typeof source === "object" && !Array.isArray(source) ? source : {};
}

export function defaultScmScheduleFormattingRules() {
  return {
    status: Object.fromEntries(SCM_SCHEDULE_PREFERENCE_STATUSES.map((status) => [
      status,
      defaultRule({ row: defaultStatusRows[status] || null })
    ])),
    type: Object.fromEntries(SCM_SCHEDULE_FORMATTING_TYPES.map((type) => [
      type,
      defaultRule()
    ])),
    dropoffPoint: {}
  };
}

export function normalizeScmScheduleFormattingRules(value = {}, { reset = false } = {}) {
  const defaults = defaultScmScheduleFormattingRules();
  if (reset) return defaults;
  const source = sourceRules(value);
  const statusSource = source.status && typeof source.status === "object" ? source.status : {};
  const typeSource = source.type && typeof source.type === "object" ? source.type : {};
  const dropoffSource = source.dropoffPoint && typeof source.dropoffPoint === "object"
    ? source.dropoffPoint
    : source.dropoff && typeof source.dropoff === "object"
      ? source.dropoff
      : {};
  const invalidStatus = Object.keys(statusSource).find((status) => !statusSet.has(status));
  if (invalidStatus) throw formattingError(`Unknown PO/TO Schedule status formatting key: ${invalidStatus}.`);
  const invalidType = Object.keys(typeSource).find((type) => !typeSet.has(type));
  if (invalidType) throw formattingError(`Unknown PO/TO Schedule type formatting key: ${invalidType}.`);
  const dropoffEntries = Object.entries(dropoffSource);
  if (dropoffEntries.length > 100) {
    throw formattingError("No more than 100 Drop-off Point formatting rules can be saved.");
  }
  return {
    status: Object.fromEntries(SCM_SCHEDULE_PREFERENCE_STATUSES.map((status) => [
      status,
      normalizeRule(statusSource[status], defaults.status[status], {
        allowRow: true,
        label: `${status} status`
      })
    ])),
    type: Object.fromEntries(SCM_SCHEDULE_FORMATTING_TYPES.map((type) => [
      type,
      normalizeRule(typeSource[type], defaults.type[type], { label: `${type} type` })
    ])),
    dropoffPoint: Object.fromEntries(dropoffEntries.map(([key, rule]) => {
      const cleanKey = cleanDropoffKey(key);
      return [
        cleanKey,
        normalizeRule(rule, defaultRule(), { label: `${cleanKey} Drop-off Point` })
      ];
    }))
  };
}

export async function listScmScheduleFormattingDropoffPoints(configured = []) {
  const result = await query(
    `SELECT DISTINCT BTRIM(value) AS value
       FROM (
         SELECT dropoff_point AS value FROM scm_transport_schedule
         UNION ALL
         SELECT destination_location AS value FROM purchase_orders
         UNION ALL
         SELECT to_location AS value FROM transfer_orders
         UNION ALL
         SELECT dropoff_location AS value FROM scm_vrma_orders
       ) points
      WHERE NULLIF(BTRIM(value), '') IS NOT NULL
      ORDER BY BTRIM(value)`
  );
  return [...new Set([
    "3445",
    "12441",
    "2967",
    "150",
    ...configured,
    ...result.rows.map((row) => String(row.value || "").trim())
  ].filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
  );
}

function publicFormatting(row, dropoffPoints) {
  const rules = normalizeScmScheduleFormattingRules(row?.rules || {});
  return {
    version: 1,
    rules,
    defaults: defaultScmScheduleFormattingRules(),
    options: {
      statuses: [...SCM_SCHEDULE_PREFERENCE_STATUSES],
      types: [...SCM_SCHEDULE_FORMATTING_TYPES],
      dropoffPoints
    },
    presets: [...SCM_SCHEDULE_COLOR_PRESETS],
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || ""
  };
}

export async function getScmScheduleFormatting() {
  const result = await query(
    `SELECT rules, updated_by, updated_at
       FROM scm_schedule_formatting_settings
      WHERE singleton_id = 1`
  );
  const configured = Object.keys(result.rows[0]?.rules?.dropoffPoint || {});
  const dropoffPoints = await listScmScheduleFormattingDropoffPoints(configured);
  return publicFormatting(result.rows[0], dropoffPoints);
}

export async function updateScmScheduleFormatting(value = {}, updatedBy = "") {
  const rules = normalizeScmScheduleFormattingRules(value, {
    reset: value?.reset === true
  });
  const result = await query(
    `INSERT INTO scm_schedule_formatting_settings (
       singleton_id, rules, updated_by, updated_at
     ) VALUES (1, $1::jsonb, $2, now())
     ON CONFLICT (singleton_id) DO UPDATE SET
       rules = EXCLUDED.rules,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING rules, updated_by, updated_at`,
    [JSON.stringify(rules), String(updatedBy || "").trim()]
  );
  const dropoffPoints = await listScmScheduleFormattingDropoffPoints(
    Object.keys(rules.dropoffPoint)
  );
  return publicFormatting(result.rows[0], dropoffPoints);
}
