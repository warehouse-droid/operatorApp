import { createHash } from "node:crypto";

function date(value) {
  if (!value) return "";
  const raw = String(value);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return new Date(value).toISOString().slice(0, 10);
}

function number(value) {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

// SuiteQL can return date-only lastmodifieddate values. Content is also checked
// so two different versions of a PO on the same day cannot overwrite each other.
export function scmNetSuitePoVersion(snapshot) {
  const current = snapshot.current || snapshot;
  const lines = (current.lines || []).map((line) => [
    Number(line.lineId), Number(line.itemId), number(line.quantity),
    number(line.rate), number(line.amount),
    Number(line.destinationLocationId ?? line.locationId ?? 0),
    Number(line.receivedQuantity || 0), Boolean(line.closed), String(line.unit || "")
  ]).sort((left, right) => left[0] - right[0]);
  const content = [
    date(current.transactionDate || current.trandate), date(current.expectedDeliveryDate),
    Number(current.vendorId || 0), String(current.status || ""),
    String(current.memo || "").trim(), String(current.vendorReference || "").trim(), lines
  ];
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
