// @ts-check

/** @param {Record<string, any> | null} [line] @returns {number | null} */
export function readNetSuiteOrderLine(line = {}) {
  const values = [line?.netsuite_order_line, line?.orderLine, line?.order_line, line?.restLineId, line?.rest_line_id]
    .filter(value => value !== undefined && value !== null && value !== "");
  const parsed = values.map(value => {
    const text = String(value).trim();
    const number = Number(text);
    if (!["string", "number"].includes(typeof value) || !/^[0-9]+$/u.test(text)
        || !Number.isSafeInteger(number) || number <= 0) {
      throw Object.assign(new Error("NetSuite orderLine must be a positive safe integer."), { code: "NETSUITE_ORDER_LINE_INVALID" });
    }
    return number;
  });
  if (new Set(parsed).size > 1) {
    throw Object.assign(new Error("NetSuite orderLine identifiers disagree."), { code: "NETSUITE_ORDER_LINE_INVALID" });
  }
  return parsed[0] ?? null;
}

/** @param {Record<string, any>[]} lines @param {string} kind */
export function withNetSuiteOrderLines(lines, kind) {
  if (!["SO", "PO", "TO"].includes(kind)) {throw new Error("An SO, PO, or TO source is required.");}
  return lines.map(line => {
    const anchors = kind === "TO"
      ? lines.filter(candidate => candidate.stage === "outbound" && candidate.logicalLineIdentity
          && candidate.logicalLineIdentity === line.logicalLineIdentity)
      : [line];
    const anchor = anchors.length === 1 ? anchors[0] : null;
    const value = line.identityStatus === "exact" && anchor?.identityStatus === "exact"
      ? readNetSuiteOrderLine({ orderLine: anchor.orderLine }) : null;
    return { ...line, netsuite_order_line: value };
  });
}
