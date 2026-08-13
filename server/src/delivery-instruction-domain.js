export const DELIVERY_INSTRUCTION_MAX_TEXT_LENGTH = 5000;
export const DELIVERY_INSTRUCTION_MAX_MEDIA = 5;
export const DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const DELIVERY_INSTRUCTION_IMAGE_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif"
]);
export const DELIVERY_INSTRUCTION_VIDEO_TYPES = Object.freeze([
  "video/mp4",
  "video/quicktime",
  "video/webm"
]);
export const DELIVERY_INSTRUCTION_MEDIA_TYPES = Object.freeze([
  ...DELIVERY_INSTRUCTION_IMAGE_TYPES,
  ...DELIVERY_INSTRUCTION_VIDEO_TYPES
]);

const ADDRESS_LABEL = /^(?:delivery\s+address|address|addr|add|ship\s+to|deliver\s+to|送货地址|地址)\s*[:：-]\s*/iu;
const DATE_TIME_LABEL = /^(?:delivery\s+date|delivery\s+day|schedule\s+date|date|delivery\s+time|delivery\s+window|送货日期|送货时间|日期|时间)\s*[:：-]\s*/iu;
const NON_PLANNED_LABEL = /(?:^|[|;]\s*)(?:tel(?:ephone)?|phone|contact|call|drop[ -]?off(?:\s+loc(?:ation)?)?|placement|gate|po\s*#?|联系电话|联系人|砖的放置|放置|摆放位置)\s*[:：-]/iu;
const PHONE_PATTERN = /(?:\+\d{1,3}[\s().-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?/giu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function domainError(message, status = 400, code = "DELIVERY_INSTRUCTION_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function normalizedLines(value) {
  return String(value || "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim());
}

function trimEmptyEdgeLines(lines) {
  const result = [...lines];
  while (result[0] === "") result.shift();
  while (result.at(-1) === "") result.pop();
  return result;
}

function phoneHref(value) {
  const extension = String(value || "").match(/(?:x|ext\.?|extension)\s*(\d{1,6})/iu)?.[1] || "";
  const digits = String(value || "").replace(/(?:x|ext\.?|extension)\s*\d{1,6}/giu, "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return "";
  const international = String(value || "").trim().startsWith("+")
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? `+${digits}`
        : `+${digits}`;
  return extension ? `${international};ext=${extension}` : international;
}

export function extractDeliveryInstructionPhones(value) {
  const seen = new Set();
  const phones = [];
  for (const match of String(value || "").matchAll(PHONE_PATTERN)) {
    const display = String(match[0] || "").trim();
    const href = phoneHref(display);
    if (!display || !href || seen.has(href)) continue;
    seen.add(href);
    phones.push({ display, href });
  }
  return phones;
}

export function deriveMemoDeliveryInstruction(value) {
  const rawMemo = trimEmptyEdgeLines(normalizedLines(value)).join("\n");
  if (!rawMemo) {
    return { text: "", phones: [], fallbackUsed: false, source: "empty" };
  }

  const retained = [];
  let ambiguous = false;
  for (const line of rawMemo.split("\n")) {
    const plannedMatch = line.match(ADDRESS_LABEL) || line.match(DATE_TIME_LABEL);
    if (!plannedMatch) {
      retained.push(line);
      continue;
    }
    const plannedValue = line.slice(plannedMatch[0].length);
    if (NON_PLANNED_LABEL.test(plannedValue)) {
      ambiguous = true;
      break;
    }
  }

  const text = ambiguous ? rawMemo : trimEmptyEdgeLines(retained).join("\n");
  return {
    text,
    phones: extractDeliveryInstructionPhones(text),
    fallbackUsed: ambiguous,
    source: ambiguous ? "raw-memo-fallback" : "planned-fields-removed"
  };
}

export function normalizeDeliveryInstructionText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw domainError("Delivery instruction text must be text.");
  const text = trimEmptyEdgeLines(normalizedLines(value)).join("\n");
  if (text.length > DELIVERY_INSTRUCTION_MAX_TEXT_LENGTH) {
    throw domainError("Delivery instruction text cannot exceed 5,000 characters.");
  }
  return text;
}

export function normalizeDeliveryInstructionMedia(value = {}, { activeCount = 0 } = {}) {
  if (Number(activeCount) >= DELIVERY_INSTRUCTION_MAX_MEDIA) {
    throw domainError("A Sales Order can contain no more than five delivery-instruction files.", 409, "DELIVERY_INSTRUCTION_MEDIA_LIMIT");
  }
  const mimeType = String(value.mimeType || value.mime_type || "").trim().toLowerCase();
  if (!DELIVERY_INSTRUCTION_MEDIA_TYPES.includes(mimeType)) {
    throw domainError("This delivery-instruction media type is not supported.", 415, "DELIVERY_INSTRUCTION_MEDIA_TYPE");
  }
  const byteSize = Number(value.byteSize ?? value.byte_size);
  if (!Number.isSafeInteger(byteSize) || byteSize < 1) {
    throw domainError("Delivery-instruction media size must be a positive whole number of bytes.");
  }
  if (byteSize > DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES) {
    throw domainError("Each delivery-instruction file must be 25 MB or smaller.", 413, "DELIVERY_INSTRUCTION_MEDIA_TOO_LARGE");
  }
  const fileName = String(value.fileName || value.file_name || "Delivery instruction file")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 255) || "Delivery instruction file";
  return {
    mimeType,
    mediaKind: DELIVERY_INSTRUCTION_IMAGE_TYPES.includes(mimeType) ? "image" : "video",
    byteSize,
    fileName
  };
}

export function assertDeliveryInstructionRevision(expectedRevision, actualRevision) {
  const expected = Number(expectedRevision);
  const actual = Number(actualRevision);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw domainError("A valid expected delivery-instruction revision is required.");
  }
  if (!Number.isSafeInteger(actual) || actual < 0 || expected !== actual) {
    throw domainError(
      "Delivery instructions changed in another session. Refresh before saving.",
      409,
      "DELIVERY_INSTRUCTION_REVISION_CONFLICT"
    );
  }
  return actual;
}

export function deliveryInstructionEditBlock({ dropoffCompleted = false, terminal = false } = {}) {
  if (dropoffCompleted) return "This Sales Order drop-off is completed and its delivery instructions are read-only.";
  if (terminal) return "This Sales Order is in a terminal NetSuite state and its delivery instructions are read-only.";
  return null;
}

export function deliveryInstructionUploadReferenceMatches(value, uploadId) {
  const id = String(uploadId || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) return false;
  const key = String(value || "").replace(/^r2:\/\//iu, "").trim();
  if (!key || key.includes("..") || key.includes("\\")) return false;
  const parts = key.split("/");
  return ["sales", "dispatch"].includes(parts[0])
    && parts[1] === "sales-delivery-instruction-media"
    && /^\d{4}$/u.test(parts[2] || "")
    && /^(?:0[1-9]|1[0-2])$/u.test(parts[3] || "")
    && /^(?:0[1-9]|[12]\d|3[01])$/u.test(parts[4] || "")
    && String(parts[5] || "").toLowerCase() === id
    && parts.length >= 7;
}
