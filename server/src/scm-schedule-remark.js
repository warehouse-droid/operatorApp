const SCM_SCHEDULE_REMARK_MAX_LENGTH = 2000;

const REMARK_PATCH_KEYS = new Set(["remarkOverride", "remark_override"]);
const REMARK_PATCH_METADATA_KEYS = new Set([
  "orderKind",
  "order_kind",
  "orderRef",
  "order_ref",
  "expectedUpdatedAt",
  "expected_updated_at",
  "audit"
]);

function cleanRemarkText(value) {
  return String(value ?? "").trim();
}

export function normalizeScmScheduleRemarkOverride(value) {
  const remark = cleanRemarkText(value);
  if (!remark) return null;
  if (remark.length > SCM_SCHEDULE_REMARK_MAX_LENGTH) {
    throw Object.assign(
      new Error(`Remark must be ${SCM_SCHEDULE_REMARK_MAX_LENGTH.toLocaleString()} characters or fewer.`),
      { status: 400, code: "SCM_REMARK_TOO_LONG" }
    );
  }
  return remark;
}

export function resolveScmScheduleRemark({
  orderKind = "",
  remarkOverride = null,
  netSuiteMemo = "",
  remarkPrefix = ""
} = {}) {
  const local = normalizeScmScheduleRemarkOverride(remarkOverride) || "";
  const memo = cleanRemarkText(netSuiteMemo);
  const kind = String(orderKind || "").trim().toUpperCase();
  const inherited = ["PO", "TO"].includes(kind) ? memo : "";
  const base = local || inherited;
  const prefix = kind === "PO" ? cleanRemarkText(remarkPrefix) : "";
  const alreadyPrefixed = base.toLowerCase().startsWith(prefix.toLowerCase())
    && (base.length === prefix.length || /^[\s:;,.-]/.test(base.slice(prefix.length)));
  return {
    remark: prefix && !alreadyPrefixed ? [prefix, base].filter(Boolean).join(" ") : base,
    remarkSource: local ? "local" : inherited ? "netsuite" : prefix ? "local" : "none",
    remarkOverride: local,
    ...(prefix ? { remarkPrefix: prefix } : {}),
    netSuiteMemo: memo
  };
}

// SQL equivalent for server-side search: use the same displayed remark before
// filtering and limiting rows. Arguments are internal SQL expressions only.
export function scmScheduleRemarkSql({ orderKind, remarkOverride, netSuiteMemo, remarkPrefix }) {
  const base = `COALESCE(NULLIF(BTRIM(${remarkOverride}), ''),
    CASE WHEN ${orderKind} IN ('PO', 'TO') THEN NULLIF(BTRIM(${netSuiteMemo}), '') END, '')`;
  const prefix = `COALESCE(CASE WHEN ${orderKind} = 'PO' THEN NULLIF(BTRIM(${remarkPrefix}), '') END, '')`;
  return `CASE WHEN ${prefix} = '' OR (
    lower(left(${base}, length(${prefix}))) = lower(${prefix})
    AND (length(${base}) = length(${prefix})
      OR substring(${base} FROM length(${prefix}) + 1 FOR 1) ~ '^[[:space:]:;,.-]')
  ) THEN ${base} ELSE concat_ws(' ', ${prefix}, NULLIF(${base}, '')) END`;
}

export function isRemarkOnlyScmSchedulePatch(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
  const keys = Object.keys(patch);
  if (!keys.some((key) => REMARK_PATCH_KEYS.has(key))) return false;
  return keys.every((key) => REMARK_PATCH_KEYS.has(key) || REMARK_PATCH_METADATA_KEYS.has(key));
}

export { SCM_SCHEDULE_REMARK_MAX_LENGTH };
