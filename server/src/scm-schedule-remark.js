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
  netSuiteMemo = ""
} = {}) {
  const local = normalizeScmScheduleRemarkOverride(remarkOverride) || "";
  const memo = cleanRemarkText(netSuiteMemo);
  if (local) {
    return {
      remark: local,
      remarkSource: "local",
      remarkOverride: local,
      netSuiteMemo: memo
    };
  }
  if (String(orderKind || "").trim().toUpperCase() === "TO" && memo) {
    return {
      remark: memo,
      remarkSource: "netsuite",
      remarkOverride: "",
      netSuiteMemo: memo
    };
  }
  return {
    remark: "",
    remarkSource: "none",
    remarkOverride: "",
    netSuiteMemo: memo
  };
}

export function isRemarkOnlyScmSchedulePatch(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
  const keys = Object.keys(patch);
  if (!keys.some((key) => REMARK_PATCH_KEYS.has(key))) return false;
  return keys.every((key) => REMARK_PATCH_KEYS.has(key) || REMARK_PATCH_METADATA_KEYS.has(key));
}

export { SCM_SCHEDULE_REMARK_MAX_LENGTH };
